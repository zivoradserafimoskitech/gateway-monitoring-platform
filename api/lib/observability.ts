// v7/C9: observability — Prometheus /metrics endpoint, request-id logging
// middleware, and a platform watchdog that raises (and auto-resolves) alarms
// when ingestion itself is unhealthy (MQTT disconnected, poller stalled).
// Watchdog alarms flow through the normal C2 notification path.
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { alarms } from "@db/schema";
import { getTelemetryStats } from "../telemetry";
import { getMqttStatus } from "../mqtt/service";
import { getPollerStatus } from "../poller/service";
import { isDuplicateKey } from "../mqtt/handlers";
import { notifyAlarmBreach } from "../alarms/notify";

const bootAt = Date.now();
const http = { total: 0, errors: 0, byPath: new Map<string, number>() };

export function httpRequestDone(method: string, path: string, status: number, ms: number, reqId: string): void {
  http.total++;
  if (status >= 500) http.errors++;
  const key = `${method} ${path.split("?")[0]}`;
  http.byPath.set(key, (http.byPath.get(key) ?? 0) + 1);
  if (status >= 500 || ms > 2000) {
    console.warn(`[http] ${reqId} ${method} ${path} ${status} ${ms}ms`);
  } else {
    console.log(`[http] ${reqId} ${method} ${path} ${status} ${ms}ms`);
  }
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export async function metricsText(): Promise<string> {
  const db = getDb();
  const tel = getTelemetryStats();
  const mqtt = getMqttStatus();
  const poller = getPollerStatus();
  const [alarmRow] = (
    (await db.execute(sql`select count(*) as n from alarms where status = 'active'`)) as unknown as [
      { n: number }[],
    ]
  )[0];
  const [gwRow] = (
    (await db.execute(
      sql`select sum(status = 'online') as online, sum(status != 'online') as offline from gateways`,
    )) as unknown as [{ online: number | null; offline: number | null }[]]
  )[0];
  const [meterRow] = (
    (await db.execute(sql`select count(*) as n from meters`)) as unknown as [{ n: number }[]]
  )[0];
  const pollerPolls = poller.devices.reduce((n, d) => n + d.polls, 0);
  const pollerFailures = poller.devices.reduce((n, d) => n + d.failures, 0);
  const lastOkAges = poller.devices
    .filter((d) => d.lastOkAt)
    .map((d) => Math.floor((Date.now() - new Date(d.lastOkAt as unknown as string).getTime()) / 1000));

  const lines: string[] = [
    "# HELP enertrek_uptime_seconds Process uptime in seconds",
    "# TYPE enertrek_uptime_seconds gauge",
    `enertrek_uptime_seconds ${Math.floor(process.uptime())}`,
    "# HELP enertrek_mqtt_connected MQTT client connection state (1=connected)",
    "# TYPE enertrek_mqtt_connected gauge",
    `enertrek_mqtt_connected ${mqtt.running && mqtt.connected ? 1 : 0}`,
    "# HELP enertrek_mqtt_messages_in_total MQTT telemetry messages received",
    "# TYPE enertrek_mqtt_messages_in_total counter",
    `enertrek_mqtt_messages_in_total ${mqtt.running ? (mqtt.messagesIn ?? 0) : 0}`,
    "# HELP enertrek_telemetry_rows_written_total Telemetry rows persisted",
    "# TYPE enertrek_telemetry_rows_written_total counter",
    `enertrek_telemetry_rows_written_total ${tel.rowsWritten}`,
    "# HELP enertrek_telemetry_rows_failed_total Telemetry rows that exhausted retries (kept in WAL)",
    "# TYPE enertrek_telemetry_rows_failed_total counter",
    `enertrek_telemetry_rows_failed_total ${tel.failed}`,
    "# HELP enertrek_telemetry_rows_dropped_total Telemetry rows dropped by queue backpressure",
    "# TYPE enertrek_telemetry_rows_dropped_total counter",
    `enertrek_telemetry_rows_dropped_total ${tel.dropped}`,
    "# HELP enertrek_telemetry_queue_length In-memory ingestion queue length",
    "# TYPE enertrek_telemetry_queue_length gauge",
    `enertrek_telemetry_queue_length ${tel.queueLength}`,
    "# HELP enertrek_telemetry_retries_total Batch write retries",
    "# TYPE enertrek_telemetry_retries_total counter",
    `enertrek_telemetry_retries_total ${tel.retries}`,
    "# HELP enertrek_poller_devices Modbus TCP devices being polled",
    "# TYPE enertrek_poller_devices gauge",
    `enertrek_poller_devices ${poller.devices.length}`,
    "# HELP enertrek_poller_polls_total Successful Modbus polls",
    "# TYPE enertrek_poller_polls_total counter",
    `enertrek_poller_polls_total ${pollerPolls}`,
    "# HELP enertrek_poller_failures_total Failed Modbus polls",
    "# TYPE enertrek_poller_failures_total counter",
    `enertrek_poller_failures_total ${pollerFailures}`,
    "# HELP enertrek_poller_last_success_age_seconds Age of the newest successful poll (missing when none)",
    "# TYPE enertrek_poller_last_success_age_seconds gauge",
  ];
  if (lastOkAges.length > 0) lines.push(`enertrek_poller_last_success_age_seconds ${Math.min(...lastOkAges)}`);
  lines.push(
    "# HELP enertrek_alarms_active Currently active alarms",
    "# TYPE enertrek_alarms_active gauge",
    `enertrek_alarms_active ${Number(alarmRow?.n ?? 0)}`,
    "# HELP enertrek_gateways Gateways by liveness",
    "# TYPE enertrek_gateways gauge",
    `enertrek_gateways{state="online"} ${Number(gwRow?.online ?? 0)}`,
    `enertrek_gateways{state="offline"} ${Number(gwRow?.offline ?? 0)}`,
    "# HELP enertrek_meters_total Registered meters/devices",
    "# TYPE enertrek_meters_total gauge",
    `enertrek_meters_total ${Number(meterRow?.n ?? 0)}`,
    "# HELP enertrek_http_requests_total API requests handled",
    "# TYPE enertrek_http_requests_total counter",
    `enertrek_http_requests_total ${http.total}`,
    "# HELP enertrek_http_request_errors_total API 5xx responses",
    "# TYPE enertrek_http_request_errors_total counter",
    `enertrek_http_request_errors_total ${http.errors}`,
  );
  for (const [k, v] of http.byPath) {
    lines.push(`enertrek_http_requests_by_path{path="${esc(k)}"} ${v}`);
  }
  return lines.join("\n") + "\n";
}

// ─── Platform watchdog ───────────────────────────────────────────────────────
const WATCHDOG_MS = 60_000;
const STARTUP_GRACE_MS = 2 * 60_000;
const POLLER_STALL_MS = 5 * 60_000;

const WATCHDOG_METRICS = {
  mqtt: "platformWatchdogMqtt",
  poller: "platformWatchdogPoller",
} as const;

async function setWatchdogCondition(metric: string, active: boolean, message: string): Promise<void> {
  const db = getDb();
  if (active) {
    try {
      const inserted = await db
        .insert(alarms)
        .values({
          ruleId: null,
          meterId: null,
          gatewayId: null,
          metric,
          severity: "critical",
          message,
          status: "active",
          triggeredAt: new Date(),
        })
        .$returningId();
      if (inserted[0]?.id) void notifyAlarmBreach(inserted[0].id);
    } catch (err) {
      if (!isDuplicateKey(err)) throw err; // already active — dedup key did its job
    }
  } else {
    // Auto-resolve any active/acknowledged watchdog alarm for this metric.
    await db.execute(sql`
      update alarms set status = 'resolved', resolved_at = now()
      where metric = ${metric} and status in ('active','acknowledged')`);
  }
}

// Exported for the C9 probe (scripts/probe-v7-observability.ts).
export async function watchdogTick(): Promise<void> {
  if (Date.now() - bootAt < STARTUP_GRACE_MS) return;
  // MQTT: service running but broker connection down.
  const mqtt = getMqttStatus();
  const mqttDown = !mqtt.running || !mqtt.connected;
  await setWatchdogCondition(
    WATCHDOG_METRICS.mqtt,
    mqttDown,
    mqttDown
      ? `Platform watchdog: MQTT ingestion is ${mqtt.running ? "disconnected" : "not running"}${mqtt.running && mqtt.lastError ? ` (${mqtt.lastError})` : ""}`
      : "",
  );
  // Poller: devices configured but no successful poll in 5 minutes (and the
  // poller has actually tried — don't fire on a freshly added device).
  const poller = getPollerStatus();
  const attempts = poller.devices.reduce((n, d) => n + d.polls + d.failures, 0);
  const successes = poller.devices.reduce((n, d) => n + d.polls, 0);
  const newestOk = poller.devices
    .map((d) => (d.lastOkAt ? new Date(d.lastOkAt as unknown as string).getTime() : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  const stalled =
    poller.devices.length > 0 &&
    attempts > 0 &&
    (successes === 0 ? Date.now() - bootAt > POLLER_STALL_MS : Date.now() - newestOk > POLLER_STALL_MS);
  await setWatchdogCondition(
    WATCHDOG_METRICS.poller,
    stalled,
    stalled
      ? `Platform watchdog: ${poller.devices.length} Modbus device(s) configured but no successful poll in the last 5 minutes`
      : "",
  );
}

let watchdogTimer: NodeJS.Timeout | null = null;
export function startWatchdogLoop(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    watchdogTick().catch((err) => console.error("[watchdog] tick failed:", err instanceof Error ? err.message : err));
  }, WATCHDOG_MS);
  watchdogTimer.unref?.();
}
