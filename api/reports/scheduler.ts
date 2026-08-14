// v8/D3: scheduled-report loop.
//
// Due rule (site-local time, IANA tz via Intl — UTC for fleet schedules):
//   daily   → local hour == hourLocal (runs once per day)
//   weekly  → local hour == hourLocal AND local weekday == Monday
//   monthly → local hour == hourLocal AND local day-of-month == 1
// and lastRunAt is not already inside the current period. A due schedule
// generates the PREVIOUS COMPLETED period (yesterday / last ISO week / last
// calendar month); runNow generates the CURRENT period to date so operators
// can test with live data.
//
// The tick and every schedule run are individually try/caught — the loop
// never dies. Files land in data/reports/; delivery via api/lib/mailer.
import fs from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { reportSchedules, sites } from "@db/schema";
import type { ReportSchedule } from "@db/schema";
import { localDayRanges, tzOffsetMs } from "../lib/tz";
import { queryEnergyReport } from "./energy-query";
import { generateReportFile } from "./generate";
import { sendMail } from "../lib/mailer";
import { captureError, guarded } from "../lib/error-reporting";

const TICK_MIN = parseInt(process.env.REPORT_TICK_MIN || "5", 10);
let timer: NodeJS.Timeout | null = null;

export function startReportLoop(): void {
  if (timer) return;
  if (TICK_MIN <= 0) {
    console.log("[reports] disabled via REPORT_TICK_MIN<=0"); // v8/D6: probe/secondary-replica switch
    return;
  }
  // Audit wave 4: guarded() reports a tick failure (Sentry/log) and never
  // rethrows — same loop-survives behavior as the previous .catch(console).
  const tick = guarded("report-scheduler", reportTick);
  timer = setInterval(() => {
    void tick();
  }, TICK_MIN * 60_000);
  timer.unref?.();
  void tick();
  console.log(`[reports] scheduler started (tick ${TICK_MIN} min)`);
}

// ─── Local clock helpers ─────────────────────────────────────────────────────
interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  isoDow: number; // 0=Monday..6=Sunday
  hour: number;
  dateLabel: string; // YYYY-MM-DD
}

function localParts(tz: string, now: Date): LocalParts {
  const local = new Date(now.getTime() + tzOffsetMs(tz, now));
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const day = local.getUTCDate();
  return {
    year,
    month,
    day,
    isoDow: (local.getUTCDay() + 6) % 7,
    hour: local.getUTCHours(),
    dateLabel: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Key identifying "the period now belongs to" — dedupes runs within it. */
function periodKey(p: LocalParts, freq: "daily" | "weekly" | "monthly"): string {
  if (freq === "daily") return p.dateLabel;
  if (freq === "monthly") return `${p.year}-${String(p.month).padStart(2, "0")}`;
  // Week = its Monday's local date (dedup only needs per-week uniqueness).
  return shiftLabel(p.dateLabel, -p.isoDow);
}

export interface ReportPeriod {
  from: Date;
  to: Date;
  label: string;
  key: string;
}

/** UTC bounds of a local date range via localDayRanges (DST-exact). */
function boundsOfDays(tz: string, fromLabel: string, toLabel: string): { from: Date; to: Date } {
  const ranges = localDayRanges(tz, new Date(`${fromLabel}T00:00:00Z`), new Date(`${toLabel}T00:00:00Z`));
  return { from: ranges[0].startUtc, to: ranges[ranges.length - 1].endUtc };
}

function shiftLabel(label: string, days: number): string {
  return new Date(new Date(`${label}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The reporting period: current period to date (runNow) or the previous
 * completed period (scheduled delivery).
 */
export function reportPeriod(freq: "daily" | "weekly" | "monthly", now: Date, tz: string, current: boolean): ReportPeriod {
  const p = localParts(tz, now);
  if (freq === "daily") {
    const startLabel = current ? p.dateLabel : shiftLabel(p.dateLabel, -1);
    const endLabel = current ? p.dateLabel : shiftLabel(p.dateLabel, -1);
    const { from } = boundsOfDays(tz, startLabel, endLabel);
    const to = current ? now : boundsOfDays(tz, p.dateLabel, p.dateLabel).from;
    return { from, to, label: `${startLabel}${current ? " (to date)" : ""}`, key: startLabel };
  }
  if (freq === "weekly") {
    const monday = shiftLabel(p.dateLabel, -p.isoDow);
    const startLabel = current ? monday : shiftLabel(monday, -7);
    const endLabel = current ? p.dateLabel : shiftLabel(monday, -1);
    const { from } = boundsOfDays(tz, startLabel, startLabel);
    const to = current ? now : boundsOfDays(tz, monday, monday).from;
    return { from, to, label: `${startLabel} → ${endLabel}${current ? " (to date)" : ""}`, key: `week-${startLabel}` };
  }
  // monthly
  const first = `${p.year}-${String(p.month).padStart(2, "0")}-01`;
  const prevFirst = new Date(Date.UTC(p.year, p.month - 2, 1)).toISOString().slice(0, 10);
  const startLabel = current ? first : prevFirst;
  const endLabel = current ? p.dateLabel : shiftLabel(first, -1);
  const { from } = boundsOfDays(tz, startLabel, startLabel);
  const to = current ? now : boundsOfDays(tz, first, first).from;
  return { from, to, label: `${startLabel} → ${endLabel}${current ? " (to date)" : ""}`, key: startLabel.slice(0, 7) };
}

function isDue(s: ReportSchedule, now: Date, tz: string): boolean {
  const p = localParts(tz, now);
  if (p.hour !== s.hourLocal) return false;
  if (s.frequency === "weekly" && p.isoDow !== 0) return false;
  if (s.frequency === "monthly" && p.day !== 1) return false;
  if (!s.lastRunAt) return true;
  return periodKey(localParts(tz, s.lastRunAt), s.frequency) !== periodKey(p, s.frequency);
}

// ─── Generation + delivery ───────────────────────────────────────────────────
export interface RunResult {
  scheduleId: number;
  path: string;
  filename: string;
  bytes: number;
  transport: string;
  period: string;
  recipients: number;
}

export async function runSchedule(s: ReportSchedule, opts: { current: boolean }): Promise<RunResult> {
  const db = getDb();
  let tz = "UTC";
  if (s.siteId != null) {
    const rows = await db.select({ timezone: sites.timezone }).from(sites).where(eq(sites.id, s.siteId)).limit(1);
    tz = rows[0]?.timezone ?? "UTC";
  }
  const now = new Date();
  const period = reportPeriod(s.frequency, now, tz, opts.current);
  const report = await queryEnergyReport({ scope: "site", siteId: s.siteId ?? undefined, from: period.from, to: period.to });
  const safeName = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "report";
  const file = await generateReportFile(report, {
    title: `VoltTrade energy report — ${s.name}`,
    periodLabel: period.label,
    format: s.format,
    fileBase: `${safeName}-${s.id}-${period.key}${opts.current ? "-adhoc" : ""}`,
  });
  const recipients = Array.isArray(s.recipients) ? (s.recipients as string[]).filter((r) => typeof r === "string" && r.includes("@")) : [];
  let transport = "none (no recipients)";
  if (recipients.length > 0) {
    const res = await sendMail({
      to: recipients,
      subject: `[VoltTrade] ${s.name} — energy report ${period.label}`,
      text:
        `Scheduled report "${s.name}" (${s.frequency}, site: ${report.scopeLabel})\n` +
        `Period: ${period.label}\n` +
        `Totals: import ${report.totalImportKwh} kWh, export ${report.totalExportKwh} kWh across ${report.meters.length} device(s).\n` +
        `File: ${file.path}`,
      attachments: [{ filename: file.filename, content: fs.readFileSync(file.path) }],
    });
    transport = res.transport;
  }
  await db.update(reportSchedules).set({ lastRunAt: new Date() }).where(eq(reportSchedules.id, s.id));
  return { scheduleId: s.id, path: file.path, filename: file.filename, bytes: file.bytes, transport, period: period.label, recipients: recipients.length };
}

export async function reportTick(): Promise<void> {
  try {
    const db = getDb();
    const schedules = await db.select().from(reportSchedules).where(eq(reportSchedules.enabled, true));
    if (schedules.length === 0) return;
    const tzCache = new Map<number | null, string>();
    const now = new Date();
    for (const s of schedules) {
      try {
        let tz = tzCache.get(s.siteId);
        if (tz === undefined) {
          if (s.siteId != null) {
            const rows = await db.select({ timezone: sites.timezone }).from(sites).where(eq(sites.id, s.siteId)).limit(1);
            tz = rows[0]?.timezone ?? "UTC";
          } else {
            tz = "UTC";
          }
          tzCache.set(s.siteId, tz);
        }
        if (!isDue(s, now, tz)) continue;
        // v8/D6: multi-replica at-most-once claim. Two replicas both pass
        // isDue in the same minute — atomically stamp last_run_at with a
        // conditional UPDATE guarded on the period start; exactly one replica
        // wins the row lock in TiDB and proceeds. The loser sees 0 affected
        // rows and skips. Trade-off (documented in docs/ha.md): if the winner
        // then crashes mid-send, that period's email is lost rather than
        // double-sent — acceptable for report mail.
        const period = reportPeriod(s.frequency, now, tz, false);
        const utc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
        const claimed = await db.execute(sql`UPDATE report_schedules SET last_run_at = ${utc(now)} WHERE id = ${s.id} AND (last_run_at IS NULL OR last_run_at < ${utc(period.from)})`);
        if (Number((claimed[0] as { affectedRows?: number }).affectedRows ?? 0) === 0) continue;
        const res = await runSchedule(s, { current: false });
        console.log(`[reports] schedule ${s.id} "${s.name}" → ${res.path} (${res.bytes} B, ${res.transport})`);
      } catch (err) {
        console.error(`[reports] schedule ${s.id} failed:`, err instanceof Error ? err.message : err);
        // Audit wave 4: a failed scheduled report must alert a human, not
        // just a log line (60s dedupe keeps a broken schedule from spamming).
        captureError(err, { task: "report-schedule", scheduleId: s.id });
      }
    }
  } catch (err) {
    console.error("[reports] tick error:", err instanceof Error ? err.message : err);
  }
}
