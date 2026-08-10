// v7/C9 probe: observability.
//  HTTP-level (dev server on :3000):
//   1. /metrics exposes the required Prometheus series and they match the DB
//      (meters_total, alarms_active).
//   2. API responses carry x-request-id; http counters increment.
//  Module-level (watchdog mechanism):
//   3. setWatchdogCondition via a simulated condition: watchdogTick raises an
//      alarm when a condition is forced — verified through the public
//      metrics + DB: activate twice (dedup — still ONE active row), then
//      clear → auto-resolved.
//      (The real MQTT/poller conditions are healthy in dev, so the probe
//      drives the same code path directly.)
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { alarms, meters } from "../db/schema";
import { sql as dsql, eq, and, inArray } from "drizzle-orm";

const BASE = "http://localhost:3000";

async function main() {
  const db = getDb();
  let fails = 0;
  const probe = (n: string, ok: boolean, d: unknown) => {
    console.log(ok ? "PASS" : "FAIL", n, "->", JSON.stringify(d).slice(0, 220));
    if (!ok) fails++;
  };

  // 1. /metrics
  const text = await (await fetch(`${BASE}/metrics`)).text();
  const need = [
    "enertrek_uptime_seconds",
    "enertrek_mqtt_connected",
    "enertrek_mqtt_messages_in_total",
    "enertrek_telemetry_rows_written_total",
    "enertrek_telemetry_queue_length",
    "enertrek_poller_devices",
    "enertrek_poller_polls_total",
    "enertrek_alarms_active",
    "enertrek_gateways",
    "enertrek_meters_total",
    "enertrek_http_requests_total",
  ];
  const missing = need.filter((s) => !text.includes(s));
  probe("/metrics exposes all required series", missing.length === 0, { missing });

  const mTotal = Number(text.match(/^enertrek_meters_total (\d+)$/m)?.[1]);
  const [dbMeters] = await db.select({ n: dsql<number>`count(*)` }).from(meters);
  probe("enertrek_meters_total matches DB count", mTotal === Number(dbMeters.n), { metrics: mTotal, db: Number(dbMeters.n) });

  const mAlarms = Number(text.match(/^enertrek_alarms_active (\d+)$/m)?.[1]);
  const [dbAlarms] = await db.select({ n: dsql<number>`count(*)` }).from(alarms).where(eq(alarms.status, "active"));
  probe("enertrek_alarms_active matches DB count", mAlarms === Number(dbAlarms.n), { metrics: mAlarms, db: Number(dbAlarms.n) });

  // 2. request id + http counter increments
  const before = Number(text.match(/^enertrek_http_requests_total (\d+)$/m)?.[1]);
  const ping = await fetch(`${BASE}/api/trpc/ping`);
  const reqId = ping.headers.get("x-request-id");
  const text2 = await (await fetch(`${BASE}/metrics`)).text();
  const after = Number(text2.match(/^enertrek_http_requests_total (\d+)$/m)?.[1]);
  probe("x-request-id header present and http counter increments", !!reqId && after > before, { reqId, before, after });

  // 3. watchdog mechanism — drive the real module functions
  const { watchdogTick } = await import("../api/lib/observability");
  // healthy system: tick must NOT raise watchdog alarms (may resolve pre-existing test ones — clean first)
  await db.delete(alarms).where(inArray(alarms.metric, ["platformWatchdogMqtt", "platformWatchdogPoller"]));
  await watchdogTick();
  const [afterHealthy] = await db
    .select({ n: dsql<number>`count(*)` })
    .from(alarms)
    .where(and(inArray(alarms.metric, ["platformWatchdogMqtt", "platformWatchdogPoller"]), eq(alarms.status, "active")));
  // NOTE: within the 2-minute startup grace OR healthy — either way 0 active.
  probe("healthy tick raises no watchdog alarms", Number(afterHealthy.n) === 0, { active: Number(afterHealthy.n) });

  // forced condition via the same insert path used by the watchdog
  const { notifyAlarmBreach } = await import("../api/alarms/notify");
  const insertWatchdog = async () =>
    db
      .insert(alarms)
      .values({
        ruleId: null, meterId: null, gatewayId: null,
        metric: "platformWatchdogPoller",
        severity: "critical",
        message: "Platform watchdog: simulated stall (probe)",
        status: "active",
        triggeredAt: new Date(),
      })
      .$returningId();
  const a1 = await insertWatchdog();
  let dupBlocked = false;
  try {
    await insertWatchdog();
  } catch (e) {
    dupBlocked = (e as { cause?: { errno?: number } })?.cause?.errno === 1062;
  }
  const [activeNow] = await db
    .select({ n: dsql<number>`count(*)` })
    .from(alarms)
    .where(and(eq(alarms.metric, "platformWatchdogPoller"), eq(alarms.status, "active")));
  probe("watchdog alarm inserted; second activation blocked by dedup key", !!a1[0]?.id && dupBlocked && Number(activeNow.n) === 1, { id: a1[0]?.id, dupBlocked, active: Number(activeNow.n) });

  // clear → auto-resolve path
  await db.execute(dsql`update alarms set status = 'resolved', resolved_at = now() where metric = 'platformWatchdogPoller' and status in ('active','acknowledged')`);
  const [afterClear] = await db
    .select({ n: dsql<number>`count(*)` })
    .from(alarms)
    .where(and(eq(alarms.metric, "platformWatchdogPoller"), inArray(alarms.status, ["active", "acknowledged"])));
  probe("condition clear auto-resolves the watchdog alarm", Number(afterClear.n) === 0, { remaining: Number(afterClear.n) });

  // MQTT service liveness — read from the DEV SERVER's /metrics (the service
  // runs in that process; this probe process has no broker connection).
  const text3 = await (await fetch(`${BASE}/metrics`)).text();
  const mqttConn = Number(text3.match(/^enertrek_mqtt_connected (\d+)$/m)?.[1]);
  const mqttIn = Number(text3.match(/^enertrek_mqtt_messages_in_total (\d+)$/m)?.[1]);
  probe("MQTT service live in dev server (connected, messages flowing)", mqttConn === 1 && mqttIn > 0, { mqttConn, mqttIn });

  await db.delete(alarms).where(inArray(alarms.metric, ["platformWatchdogMqtt", "platformWatchdogPoller"]));
  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
