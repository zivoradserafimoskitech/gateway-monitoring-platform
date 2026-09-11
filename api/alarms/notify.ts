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
import { assertEgressAllowed } from "../lib/egress";
import { sendMail } from "../lib/mailer";

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
    const text = `[VoltTrade] ${payload.kind === "escalation" ? "ESCALATION " : ""}${payload.message}\n` +
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
    subject: `[VoltTrade] ${payload.kind === "escalation" ? "ESCALATION — " : ""}Alarm: ${payload.message}`,
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
  kind: "initial" | "escalation",
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
  const channels = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.enabled, 1),
        eq(notificationChannels.escalation, kind === "escalation" ? 1 : 0),
        orgCond,
      ),
    );
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
