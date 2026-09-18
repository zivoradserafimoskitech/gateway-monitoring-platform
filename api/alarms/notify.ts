// v7/C2: alarm notification engine — webhook / telegram / email channels,
// escalation for unacknowledged alarms, maintenance-window suppression.
// §9.8 adds targeted suppression (rule / device / site, with a reason) and an
// on-call rota; the decisions themselves are pure and live in contracts/oncall.
import { and, eq, inArray, isNull, lte, gte, or, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  alarmNotifications,
  alarmSuppressions,
  alarms,
  gateways,
  maintenanceWindows,
  meters,
  notificationChannels,
  onCallShifts,
} from "@db/schema";
import type { Meter, NotificationChannel } from "@db/schema";
import { assertEgressAllowed } from "../lib/egress";
import { sendMail } from "../lib/mailer";
import {
  activeSuppression,
  applyRota,
  onDutyChannelIds,
  type AlarmSubject,
  type ShiftRow,
  type SuppressionRow,
} from "@contracts/oncall";

export type NotificationKind = "initial" | "escalation" | "resolved";

const FETCH_TIMEOUT_MS = 5000;
export const ESCALATE_AFTER_MS = parseInt(process.env.ALARM_ESCALATE_MIN ?? "15", 10) * 60_000;

// ─── Telegram target parsing ─────────────────────────────────────────────────
// A channel target is "<botToken>:<chatId>". The bot token ITSELF contains a
// colon (`<botId>:<secret>`), so the separator is the LAST colon, not the
// first — splitting on the first one yielded token="123456789" and
// chatId="AAH..." and every send failed with 404.
export interface TelegramTarget {
  token: string;
  chatId: string;
}

const TELEGRAM_BOT_TOKEN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
// Numeric chat/group id (groups are negative) or a public @channelname.
const TELEGRAM_CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export function parseTelegramTarget(target: string): TelegramTarget | null {
  const sep = target.lastIndexOf(":");
  if (sep <= 0 || sep === target.length - 1) return null;
  const token = target.slice(0, sep);
  const chatId = target.slice(sep + 1);
  if (!TELEGRAM_BOT_TOKEN.test(token)) return null;
  if (!TELEGRAM_CHAT_ID.test(chatId)) return null;
  return { token, chatId };
}

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
    // Re-check at send time, not only at creation: a hostname that resolved
    // publicly when the channel was saved can be re-pointed at an internal
    // address afterwards.
    await assertEgressAllowed(channel.target);
    await postJson(channel.target, payload);
    return;
  }
  if (channel.type === "telegram") {
    const parsed = parseTelegramTarget(channel.target);
    if (!parsed) throw new Error("telegram target must be <botToken>:<chatId>");
    const { token, chatId } = parsed;
    const prefix =
      payload.kind === "escalation" ? "ESCALATION " : payload.kind === "resolved" ? "RESOLVED " : "";
    const text = `[VoltTrade] ${prefix}${payload.message}\n` +
      `meter=${payload.meterName ?? payload.meterId} value=${payload.value} threshold=${payload.threshold} severity=${payload.severity}`;
    await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
    });
    return;
  }
  // email: go through the shared mailer (api/lib/mailer.ts) rather than
  // importing nodemailer here. The private copy only honoured SMTP_URL, so a
  // deployment configured with SMTP_HOST/PORT/USER could not send alarm mail
  // at all, and it threw "nodemailer not installed" on every attempt because
  // the optional dependency is normally absent.
  const res = await sendMail({
    to: [channel.target],
    subject:
      payload.kind === "resolved"
        ? `[VoltTrade] RESOLVED: ${payload.message}`
        : `[VoltTrade] ${payload.kind === "escalation" ? "ESCALATION — " : ""}Alarm: ${payload.message}`,
    text: JSON.stringify(payload, null, 2),
  });
  // The log transport is a legitimate dev/test choice, but silently recording
  // "sent" when no mail left the box would hide a misconfigured production
  // channel. Only accept it when it was asked for explicitly.
  if (res.transport === "log" && process.env.EMAIL_TRANSPORT !== "log") {
    throw new Error(
      "no usable SMTP configuration — install nodemailer and set SMTP_URL or " +
        "SMTP_HOST (set EMAIL_TRANSPORT=log to accept log-only delivery)",
    );
  }
}

// Which org does this alarm belong to? Meter org first, gateway org for
// meter-less alarms. NULL means the device itself is unassigned.
async function alarmOrgId(alarm: {
  meterId: number | null;
  gatewayId?: number | null;
}): Promise<number | null> {
  const db = getDb();
  if (alarm.meterId != null) {
    const m = await db
      .select({ orgId: meters.orgId })
      .from(meters)
      .where(eq(meters.id, alarm.meterId))
      .limit(1);
    if (m[0]) return m[0].orgId ?? null;
  }
  if (alarm.gatewayId != null) {
    const g = await db
      .select({ orgId: gateways.orgId })
      .from(gateways)
      .where(eq(gateways.id, alarm.gatewayId))
      .limit(1);
    if (g[0]) return g[0].orgId ?? null;
  }
  return null;
}

// §9.8: what this alarm is attached to, for matching suppression scopes. The
// effective site follows the same rule as everywhere else (v6/R7): the meter's
// own binding, else its gateway's.
async function alarmSubject(alarm: {
  ruleId?: number | null;
  meterId: number | null;
  gatewayId?: number | null;
}): Promise<AlarmSubject> {
  const db = getDb();
  let siteId: number | null = null;
  if (alarm.meterId != null) {
    const m = await db
      .select({ siteId: meters.siteId, gatewayId: meters.gatewayId })
      .from(meters)
      .where(eq(meters.id, alarm.meterId))
      .limit(1);
    siteId = m[0]?.siteId ?? null;
    if (siteId === null && m[0]?.gatewayId != null) {
      const g = await db
        .select({ siteId: gateways.siteId })
        .from(gateways)
        .where(eq(gateways.id, m[0].gatewayId))
        .limit(1);
      siteId = g[0]?.siteId ?? null;
    }
  }
  if (siteId === null && alarm.gatewayId != null) {
    const g = await db
      .select({ siteId: gateways.siteId })
      .from(gateways)
      .where(eq(gateways.id, alarm.gatewayId))
      .limit(1);
    siteId = g[0]?.siteId ?? null;
  }
  return { ruleId: alarm.ruleId ?? null, meterId: alarm.meterId ?? null, siteId };
}

// §9.8: the suppression in force for an alarm, or null.
//
// Checked at DISPATCH time rather than at raise time, and re-checked on every
// escalation: the ordinary sequence is that an alarm pages somebody, they see
// it, they suppress it while they work on it. A check that only ran when the
// alarm first fired would keep escalating the very thing they just silenced.
async function suppressionFor(alarm: {
  ruleId?: number | null;
  meterId: number | null;
  gatewayId?: number | null;
}): Promise<SuppressionRow | null> {
  const db = getDb();
  const now = new Date();
  const rows = await db
    .select({
      id: alarmSuppressions.id,
      scope: alarmSuppressions.scope,
      refId: alarmSuppressions.refId,
      startsAt: alarmSuppressions.startsAt,
      endsAt: alarmSuppressions.endsAt,
      reason: alarmSuppressions.reason,
    })
    .from(alarmSuppressions)
    .where(and(lte(alarmSuppressions.startsAt, now), gte(alarmSuppressions.endsAt, now)));
  if (rows.length === 0) return null;
  return activeSuppression(rows, await alarmSubject(alarm), now);
}

// §9.8: the on-call rota for an org — its own shifts plus any global
// (NULL-org) shift, exactly as channels are scoped.
async function rotaFor(orgId: number | null): Promise<ShiftRow[]> {
  const db = getDb();
  const cond =
    orgId === null
      ? isNull(onCallShifts.orgId)
      : or(eq(onCallShifts.orgId, orgId), isNull(onCallShifts.orgId));
  const rows = await db.select().from(onCallShifts).where(cond);
  return rows.map((r) => ({
    channelId: r.channelId,
    dayOfWeekMask: r.dayOfWeekMask,
    startMin: r.startMin,
    endMin: r.endMin,
    timezone: r.timezone,
    enabled: r.enabled,
  }));
}

async function dispatchToChannels(
  alarm: {
    id: number;
    message: string;
    severity: string;
    value: number | null;
    threshold: number | null;
    meterId: number | null;
    gatewayId?: number | null;
  },
  meterName: string | null,
  kind: NotificationKind,
): Promise<{ sent: number; failed: number }> {
  const db = getDb();
  // Tenancy: an alarm goes to its OWN org's channels plus any global
  // (NULL-org, superadmin-managed) channel. Previously it went to every
  // enabled channel in the installation, so one tenant's alarms were delivered
  // to every other tenant's webhook, Telegram chat and mailbox.
  const orgId = await alarmOrgId(alarm);
  const orgCond =
    orgId === null
      ? isNull(notificationChannels.orgId)
      : or(eq(notificationChannels.orgId, orgId), isNull(notificationChannels.orgId));

  let channels: NotificationChannel[];
  if (kind === "resolved") {
    // A resolution goes to exactly the channels that were told this alarm
    // fired — initial recipients and, if it ran long enough, escalation
    // recipients. Anyone who was never paged is not told it is over.
    const rows = await db
      .selectDistinct({ ch: notificationChannels })
      .from(notificationChannels)
      .innerJoin(alarmNotifications, eq(alarmNotifications.channelId, notificationChannels.id))
      .where(
        and(
          eq(alarmNotifications.alarmId, alarm.id),
          eq(alarmNotifications.status, "sent"),
          eq(notificationChannels.enabled, 1),
        ),
      );
    channels = rows.map((r) => r.ch);
  } else {
    channels = await db
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.enabled, 1),
          eq(notificationChannels.escalation, kind === "escalation" ? 1 : 0),
          orgCond,
        ),
      );
  }

  // §9.8: the on-call rota. A resolution is deliberately exempt — it goes to
  // whoever was actually paged, whether or not their shift has since ended.
  // Telling the person who got out of bed at 03:00 that the site recovered is
  // not a page, and routing it to the morning shift instead tells the wrong
  // person something they never needed.
  if (kind !== "resolved") {
    const r = applyRota(channels, onDutyChannelIds(await rotaFor(orgId), new Date()));
    channels = r.channels;
    if (r.gap) {
      // Worth saying out loud: the rota exists but has a hole in it, and the
      // page only went out because dispatch fails open. Silence here would
      // make an uncovered hour indistinguishable from a covered one.
      console.warn(
        `[notify] alarm ${alarm.id}: no channel on duty — rota gap, notifying all ${channels.length}`,
      );
    }
  }

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
    await db
      .insert(alarmNotifications)
      .values({ alarmId: alarm.id, channelId: ch.id, kind, status, error, orgId });
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
    // §9.8: a suppression stops the page, not the alarm. The row stays, and
    // records why nobody was called — so a post-mortem can still see that the
    // condition occurred and that somebody had decided to sit on it.
    const supp = await suppressionFor(alarm);
    if (supp) {
      await db
        .update(alarms)
        .set({ suppressedReason: supp.reason })
        .where(eq(alarms.id, alarmId));
      console.log(`[notify] alarm ${alarmId}: suppressed (${supp.scope}) — ${supp.reason}`);
      return;
    }
    const r = await dispatchToChannels(alarm, meterName, "initial");
    if (r.sent || r.failed) console.log(`[notify] alarm ${alarmId}: initial sent=${r.sent} failed=${r.failed}`);
  } catch (e) {
    console.warn("[notify] breach dispatch failed:", e instanceof Error ? e.message : e);
  }
}

// Called wherever an alarm transitions to resolved by the SYSTEM — the
// condition went away on its own. Closing the loop matters: an operator who
// was paged at 02:00 otherwise has no way to learn the site recovered except
// by opening the dashboard.
//
// Manual resolution from the UI deliberately does NOT call this: the person
// who clicked resolve already knows.
export async function notifyAlarmResolved(alarmId: number): Promise<void> {
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
    const r = await dispatchToChannels(
      { ...alarm, message: `CLEARED — ${alarm.message}` },
      meterName,
      "resolved",
    );
    if (r.sent || r.failed) {
      console.log(`[notify] alarm ${alarmId}: resolved sent=${r.sent} failed=${r.failed}`);
    }
  } catch (e) {
    console.warn("[notify] resolve dispatch failed:", e instanceof Error ? e.message : e);
  }
}

// ─── Escalation sweep ────────────────────────────────────────────────────────
export async function escalationSweep(): Promise<{ escalated: number; suppressed: number }> {
  const db = getDb();
  const cutoff = new Date(Date.now() - ESCALATE_AFTER_MS);
  // Active (never acknowledged) alarms older than the escalation delay.
  const stale = await db
    .select()
    .from(alarms)
    .where(and(eq(alarms.status, "active"), lte(alarms.triggeredAt, cutoff)))
    .limit(100);
  let escalated = 0;
  let suppressed = 0;
  for (const alarm of stale) {
    // Re-checked every sweep, not read off the alarm row: the usual sequence
    // is that the alarm pages somebody, they see it, and they suppress it
    // while they work. Escalating it fifteen minutes later would page the next
    // person up about the very thing that was just silenced.
    const supp = await suppressionFor(alarm);
    if (supp) {
      suppressed++;
      if (alarm.suppressedReason !== supp.reason) {
        await db.update(alarms).set({ suppressedReason: supp.reason }).where(eq(alarms.id, alarm.id));
      }
      continue;
    }
    const r = await dispatchToChannels(alarm, null, "escalation");
    if (r.sent > 0) escalated++;
  }
  if (suppressed > 0) console.log(`[notify] escalation sweep: ${suppressed} suppressed`);
  return { escalated, suppressed };
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
