// v7/C2: alarm notification engine — webhook / telegram / email channels,
// escalation for unacknowledged alarms, maintenance-window suppression.
import { and, eq, inArray, isNull, lte, gte, or, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  alarmNotifications,
  alarms,
  gateways,
  maintenanceWindows,
  meters,
  notificationChannels,
} from "@db/schema";
import type { Meter, NotificationChannel } from "@db/schema";

const FETCH_TIMEOUT_MS = 5000;
export const ESCALATE_AFTER_MS = parseInt(process.env.ALARM_ESCALATE_MIN ?? "15", 10) * 60_000;

// ─── Dispatch ────────────────────────────────────────────────────────────────
async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function dispatch(
  channel: NotificationChannel,
  payload: Record<string, unknown>,
): Promise<void> {
  if (channel.type === "webhook") {
    await postJson(channel.target, payload);
    return;
  }
  if (channel.type === "telegram") {
    // target = "<botToken>:<chatId>"
    const [token, chatId] = channel.target.split(":");
    if (!token || !chatId) throw new Error("telegram target must be token:chatId");
    const text = `[Enertrek] ${payload.kind === "escalation" ? "ESCALATION " : ""}${payload.message}\n` +
      `meter=${payload.meterName ?? payload.meterId} value=${payload.value} threshold=${payload.threshold} severity=${payload.severity}`;
    await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
    });
    return;
  }
  // email: SMTP via nodemailer when installed + SMTP_URL configured, else skip
  if (!process.env.SMTP_URL) throw new Error("SMTP_URL not configured");
  // Dynamic import evaluated at runtime — the dep is optional, so TS must not
  // resolve it at compile time.
  const mod: any = await (Function('return import("nodemailer")')() as Promise<any>).catch(() => null);
  if (!mod) throw new Error("nodemailer not installed");
  const transport = mod.default.createTransport(process.env.SMTP_URL);
  await transport.sendMail({
    to: channel.target,
    subject: `[Enertrek] Alarm: ${payload.message}`,
    text: JSON.stringify(payload, null, 2),
  });
}

async function dispatchToChannels(
  alarm: { id: number; message: string; severity: string; value: number | null; threshold: number | null; meterId: number | null },
  meterName: string | null,
  kind: "initial" | "escalation",
): Promise<{ sent: number; failed: number }> {
  const db = getDb();
  const channels = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.enabled, 1), eq(notificationChannels.escalation, kind === "escalation" ? 1 : 0)));
  let sent = 0;
  let failed = 0;
  for (const ch of channels) {
    // Skip duplicates (e.g. two escalations to the same channel for one alarm)
    const dup = await db
      .select({ id: alarmNotifications.id })
      .from(alarmNotifications)
      .where(
        and(
          eq(alarmNotifications.alarmId, alarm.id),
          eq(alarmNotifications.channelId, ch.id),
          eq(alarmNotifications.kind, kind),
        ),
      )
      .limit(1);
    if (dup[0]) continue;
    let status: "sent" | "failed" = "sent";
    let error: string | null = null;
    try {
      await dispatch(ch, {
        kind,
        alarmId: alarm.id,
        message: alarm.message,
        severity: alarm.severity,
        value: alarm.value,
        threshold: alarm.threshold,
        meterId: alarm.meterId,
        meterName,
        at: new Date().toISOString(),
      });
      sent++;
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : String(e);
      failed++;
    }
    await db.insert(alarmNotifications).values({ alarmId: alarm.id, channelId: ch.id, kind, status, error });
  }
  return { sent, failed };
}

// Called from the ingestion path right after a new alarm row is inserted.
export async function notifyAlarmBreach(alarmId: number): Promise<void> {
  try {
    const db = getDb();
    const rows = await db.select().from(alarms).where(eq(alarms.id, alarmId)).limit(1);
    const alarm = rows[0];
    if (!alarm) return;
    let meterName: string | null = null;
    if (alarm.meterId) {
      const m = await db.select({ name: meters.name }).from(meters).where(eq(meters.id, alarm.meterId)).limit(1);
      meterName = m[0]?.name ?? null;
    }
    const r = await dispatchToChannels(alarm, meterName, "initial");
    if (r.sent || r.failed) console.log(`[notify] alarm ${alarmId}: initial sent=${r.sent} failed=${r.failed}`);
  } catch (e) {
    console.warn("[notify] breach dispatch failed:", e instanceof Error ? e.message : e);
  }
}

// ─── Escalation sweep ────────────────────────────────────────────────────────
export async function escalationSweep(): Promise<{ escalated: number }> {
  const db = getDb();
  const cutoff = new Date(Date.now() - ESCALATE_AFTER_MS);
  // Active (never acknowledged) alarms older than the escalation delay.
  const stale = await db
    .select()
    .from(alarms)
    .where(and(eq(alarms.status, "active"), lte(alarms.triggeredAt, cutoff)))
    .limit(100);
  let escalated = 0;
  for (const alarm of stale) {
    const r = await dispatchToChannels(alarm, null, "escalation");
    if (r.sent > 0) escalated++;
  }
  return { escalated };
}

let escalationTimer: NodeJS.Timeout | null = null;
export function startEscalationLoop(): void {
  if (escalationTimer) return;
  escalationTimer = setInterval(() => {
    void escalationSweep().catch((e) => console.warn("[notify] escalation sweep:", e));
  }, 60_000);
  escalationTimer.unref();
}

// ─── Maintenance windows ─────────────────────────────────────────────────────
// Suppression cache — checking per evaluation would add a query in the hot path.
let maintCache: { at: number; global: boolean; siteIds: Set<number> } | null = null;

export function invalidateMaintenanceCache(): void {
  maintCache = null;
}

export async function isInMaintenance(meter: Meter): Promise<boolean> {
  if (!maintCache || Date.now() - maintCache.at > 30_000) {
    const db = getDb();
    const now = new Date();
    const rows = await db
      .select({ siteId: maintenanceWindows.siteId })
      .from(maintenanceWindows)
      .where(and(lte(maintenanceWindows.startsAt, now), gte(maintenanceWindows.endsAt, now)));
    maintCache = {
      at: Date.now(),
      global: rows.some((r) => r.siteId === null),
      siteIds: new Set(rows.filter((r) => r.siteId !== null).map((r) => r.siteId!)),
    };
  }
  if (maintCache.global) return true;
  // Effective site: meter's own binding, else its gateway's (v6/R7 rule).
  if (meter.siteId != null) return maintCache.siteIds.has(meter.siteId);
  const db = getDb();
  const gw = await db.select({ siteId: gateways.siteId }).from(gateways).where(eq(gateways.id, meter.gatewayId)).limit(1);
  return gw[0]?.siteId != null && maintCache.siteIds.has(gw[0].siteId);
}

// used by probes/tests
export const _internal = { or, sql, inArray, isNull };
