// MQTT ingestion service.
//
// - If MQTT_URL is set, connects to that broker (the production broker your
//   G30/C30 gateways are pointed at).
// - Otherwise connects to mqtt://127.0.0.1:MQTT_EMBEDDED_PORT (default 1883),
//   served in development by `npx tsx scripts/broker.ts` (aedes).
//
// Routing: every uplink message is matched to a gateway by the UID segment of its
// topic (auto-provisions unknown gateways), then decoded as G30 JSON or C30 raw
// Modbus RTU depending on the gateway's transport.
import mqtt, { type MqttClient } from "mqtt";
import { eq, and, lt, inArray, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { gateways, meters, alarms, alarmRules, commands } from "@db/schema";
import type { Gateway } from "@db/schema";
import { defaultTopicPrefix, defaultTransport, downlinkTopic } from "@contracts/topics";
import { handleG30Message, handleC30Frame, getRegisterMaps, meterCache, isDuplicateKey } from "./handlers";
import { buildReadRequest, registerSpan } from "../modbus";
import { getTelemetryStats } from "../telemetry";
import { markGatewaySeen } from "./liveness";
import { offlineThresholdMs } from "./offline";

const OFFLINE_AFTER_MS = 120_000;
const SWEEP_INTERVAL_MS = 30_000;

interface MqttService {
  client: MqttClient;
  brokerPort: number | null;
  startedAt: Date;
  messagesIn: number;
  lastError: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __enertrekMqtt: MqttService | undefined;
  // eslint-disable-next-line no-var
  var __enertrekSweep: NodeJS.Timeout | undefined;
}

// Gateway rows are cached — otherwise every MQTT message costs a lookup query.
const gwCache = new Map<string, { at: number; gw: Gateway }>();
const GW_CACHE_TTL_MS = 300_000;

async function findGatewayByUid(uid: string): Promise<Gateway | null> {
  const cached = gwCache.get(uid);
  if (cached && Date.now() - cached.at < GW_CACHE_TTL_MS) return cached.gw;
  const db = getDb();
  const rows = await db.select().from(gateways).where(eq(gateways.uid, uid)).limit(1);
  const gw = rows[0] ?? null;
  if (gw) gwCache.set(uid, { at: Date.now(), gw });
  return gw;
}

// Routers must call this after gateway update/delete — otherwise the 5-min
// cache keeps serving stale (or deleted) rows to the ingestion path (#16).
export function evictGatewayCache(uid?: string): void {
  if (uid === undefined) {
    gwCache.clear();
    return;
  }
  gwCache.delete(uid);
}

// UIDs rejected while auto-provisioning is disabled (log-once throttle).
const deniedUids = new Set<string>();

async function ensureGateway(uid: string, topic: string): Promise<Gateway | null> {
  const existing = await findGatewayByUid(uid);
  if (existing) return existing;

  // Auto-provisioning can be disabled so rogue devices can't inject
  // themselves into the fleet merely by publishing with a fresh UID.
  if ((process.env.MQTT_AUTO_PROVISION ?? "1") !== "1") {
    if (!deniedUids.has(uid)) {
      deniedUids.add(uid);
      console.warn(`[mqtt] auto-provision disabled; ignoring unknown gateway uid=${uid}`);
    }
    return null;
  }

  // Auto-provision: a gateway we've never seen just published to us.
  const firstSeg = topic.split("/")[0];
  const model = firstSeg === "d2g" ? ("C30" as const) : ("G30" as const);
  const db = getDb();
  try {
    const inserted = await db
      .insert(gateways)
      .values({
        uid,
        name: `${model} ${uid}`,
        model,
        transport: defaultTransport(model),
        topicPrefix: defaultTopicPrefix(model),
        status: "online",
        lastSeenAt: new Date(),
      })
      .$returningId();
    const rows = await db.select().from(gateways).where(eq(gateways.id, inserted[0].id)).limit(1);
    console.log(`[mqtt] auto-provisioned gateway ${model} uid=${uid}`);
    gwCache.set(uid, { at: Date.now(), gw: rows[0] });
    return rows[0];
  } catch {
    // Concurrent first messages raced the insert — re-read the winner
    const raced = await findGatewayByUid(uid);
    if (raced) return raced;
    throw new Error(`Failed to provision gateway ${uid}`);
  }
}

function uidFromAnyTopic(topic: string): string | null {
  const parts = topic.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // d2g/{uid}[/...] — uid is the segment right after the d2g prefix
  if (parts[0] === "d2g") return parts[1];
  // {prefix}/{uid} — uid is the last segment for G30-style topics
  return parts[parts.length - 1];
}

// Liveness goes to the batched tracker — zero DB queries in the hot path.
function markSeen(gateway: Gateway): void {
  const now = new Date();
  markGatewaySeen(gateway.id, now);
  gateway.status = "online";
  gateway.lastSeenAt = now;
}

async function onMessage(topic: string, payload: Buffer): Promise<void> {
  const svc = globalThis.__enertrekMqtt;
  if (svc) svc.messagesIn++;
  try {
    if (topic.startsWith("g2d/")) return; // our own downlink echo, ignore
    const uid = uidFromAnyTopic(topic);
    if (!uid) return;
    const gateway = await ensureGateway(uid, topic);
    if (!gateway) return;
    await markSeen(gateway);

    if (gateway.transport === "transparent") {
      const result = await handleC30Frame(gateway, payload);
      if (!result.decoded) {
        console.log(`[mqtt] C30 frame not decoded uid=${uid} len=${payload.length}`);
      }
    } else {
      const result = await handleG30Message(gateway, payload.toString("utf8"));
      if (result.readings === 0) {
        console.log(`[mqtt] G30 payload had no readings uid=${uid}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (svc) svc.lastError = msg;
    console.error(`[mqtt] message handling error on ${topic}:`, msg);
  }
}

async function offlineSweep(): Promise<void> {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);

    // Gateways inherit the slowest poll interval of their meters (#2): a
    // gateway whose devices report hourly must not flap at the 120 s floor.
    const maxIntervalRows = await db
      .select({ gatewayId: meters.gatewayId, maxInterval: sql<number>`max(${meters.pollIntervalSec})` })
      .from(meters)
      .groupBy(meters.gatewayId);
    const gwMaxInterval = new Map<number, number>(
      maxIntervalRows.map((r) => [r.gatewayId, Number(r.maxInterval) || 60]),
    );
    const onlineGateways = await db
      .select()
      .from(gateways)
      .where(and(eq(gateways.status, "online"), lt(gateways.lastSeenAt, cutoff)));
    const staleGateways = onlineGateways.filter(
      (gw) =>
        Date.now() - new Date(gw.lastSeenAt!).getTime() >
        offlineThresholdMs(gwMaxInterval.get(gw.id) ?? 60),
    );
    for (const gw of staleGateways) {
      await db.update(gateways).set({ status: "offline" }).where(eq(gateways.id, gw.id));
      // #7: an acknowledged alarm still represents an ongoing condition —
      // count it as "existing" or a restart/ack would spawn duplicates.
      const existing = await db
        .select()
        .from(alarms)
        .where(
          and(
            eq(alarms.gatewayId, gw.id),
            eq(alarms.metric, "gatewayOffline"),
            inArray(alarms.status, ["active", "acknowledged"]),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        try {
          await db.insert(alarms).values({
            gatewayId: gw.id,
            metric: "gatewayOffline",
            severity: "critical",
            message: `Gateway ${gw.name} (${gw.uid}) went offline`,
            status: "active",
            triggeredAt: new Date(),
          });
        } catch (err) {
          // #7: another sweep/evaluator won the race (unique active_dedup_key)
          if (!isDuplicateKey(err)) throw err;
        }
      }
    }

    // Per-device thresholds (#2): a meter on a 3600 s poll interval must not
    // flap offline at the 120 s floor — threshold = max(120s, 2.5×interval).
    const onlineMeters = await db
      .select({
        id: meters.id,
        lastSeenAt: meters.lastSeenAt,
        pollIntervalSec: meters.pollIntervalSec,
      })
      .from(meters)
      .where(eq(meters.status, "online"));
    const nowMs = Date.now();
    const staleMeterIds = onlineMeters
      .filter(
        (m) =>
          m.lastSeenAt !== null &&
          nowMs - new Date(m.lastSeenAt).getTime() > offlineThresholdMs(m.pollIntervalSec),
      )
      .map((m) => m.id);
    for (let i = 0; i < staleMeterIds.length; i += 500) {
      const chunk = staleMeterIds.slice(i, i + 500);
      await db.update(meters).set({ status: "offline" }).where(inArray(meters.id, chunk));
    }

    // Auto-resolve offline alarms for gateways that are back online
    // (#7: acknowledged ones too — the condition is over either way)
    const backOnline = await db
      .select({ alarmId: alarms.id })
      .from(alarms)
      .innerJoin(gateways, eq(alarms.gatewayId, gateways.id))
      .where(
        and(
          eq(alarms.metric, "gatewayOffline"),
          inArray(alarms.status, ["active", "acknowledged"]),
          eq(gateways.status, "online"),
        ),
      );
    for (const a of backOnline) {
      await db
        .update(alarms)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(eq(alarms.id, a.alarmId));
    }
  } catch (err) {
    console.error("[mqtt] offline sweep error:", err instanceof Error ? err.message : err);
  }
}

// Seed sensible default alarm rules (EN 50160 voltage/frequency limits) on first run.
async function ensureDefaultRules(): Promise<void> {
  const db = getDb();
  const existing = await db.select({ id: alarmRules.id }).from(alarmRules).limit(1);
  if (existing.length > 0) return;
  await db.insert(alarmRules).values([
    { name: "Overvoltage", metric: "voltageL1", operator: "gt", threshold: 253, severity: "warning" },
    { name: "Undervoltage", metric: "voltageL1", operator: "lt", threshold: 207, severity: "warning" },
    { name: "Frequency high", metric: "frequencyHz", operator: "gt", threshold: 50.5, severity: "info" },
    { name: "Frequency low", metric: "frequencyHz", operator: "lt", threshold: 49.5, severity: "info" },
  ]);
  console.log("[mqtt] seeded default alarm rules");
}

// Pre-warm gateway/meter caches from the DB at startup. Without this, the first
// message wave after a restart costs a metadata query per reading — thousands of
// concurrent SELECTs against MySQL before anything gets written.
async function warmCaches(): Promise<void> {
  const db = getDb();
  const gwRows = await db.select().from(gateways);
  for (const gw of gwRows) gwCache.set(gw.uid, { at: Date.now(), gw });
  const meterRows = await db.select().from(meters);
  for (const m of meterRows) meterCache.set(`${m.gatewayId}:${m.modbusAddress}`, { at: Date.now(), meter: m });
  console.log(`[mqtt] caches warmed: ${gwRows.length} gateways, ${meterRows.length} meters`);
}

export async function startMqttService(): Promise<MqttService> {
  if (globalThis.__enertrekMqtt) return globalThis.__enertrekMqtt;

  // Warm the register-map cache (seeds device profiles on first run)
  await getRegisterMaps();
  await ensureDefaultRules();
  await warmCaches();

  const externalUrl = process.env.MQTT_URL;
  const brokerPort = parseInt(process.env.MQTT_EMBEDDED_PORT || "1883", 10);
  const connectUrl = externalUrl || `mqtt://127.0.0.1:${brokerPort}`;
  if (!externalUrl) {
    console.log(`[mqtt] no MQTT_URL set — using dev broker at ${connectUrl} (run \`npx tsx scripts/broker.ts\`)`);
  }

  const client = mqtt.connect(connectUrl, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: `enertrek-cloud-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 5000,
  });

  const svc: MqttService = {
    client,
    brokerPort: externalUrl ? null : brokerPort,
    startedAt: new Date(),
    messagesIn: 0,
    lastError: null,
  };
  globalThis.__enertrekMqtt = svc;

  client.on("connect", () => {
    console.log(`[mqtt] connected to ${connectUrl}`);
    // Subscribe to everything — custom G30 topic prefixes are user-defined,
    // so a wildcard is the safest way to catch d2g/#, matis/# and anything else.
    client.subscribe(["#"], (err) => {
      if (err) console.error("[mqtt] subscribe error:", err.message);
      else console.log("[mqtt] subscribed to all topics");
    });
  });
  client.on("message", (topic, payload) => {
    void onMessage(topic, payload);
  });
  client.on("error", (err) => {
    svc.lastError = err.message;
    console.error("[mqtt] client error:", err.message);
  });

  if (!globalThis.__enertrekSweep) {
    globalThis.__enertrekSweep = setInterval(() => void offlineSweep(), SWEEP_INTERVAL_MS);
  }

  return svc;
}

export function getMqttStatus() {
  const svc = globalThis.__enertrekMqtt;
  if (!svc) return { running: false as const };
  return {
    running: true as const,
    connected: svc.client.connected,
    embeddedBrokerPort: svc.brokerPort,
    externalBroker: !!process.env.MQTT_URL,
    startedAt: svc.startedAt,
    messagesIn: svc.messagesIn,
    lastError: svc.lastError,
    telemetry: getTelemetryStats(),
  };
}

// v7/C12: publish a raw Modbus frame (e.g. FC6 control write) to a C30
// gateway's downlink topic. Command logging is the caller's job
// (control/execute.ts records user + result; sendReadNow logs its own).
export async function sendControlFrame(gateway: Gateway, frame: Buffer): Promise<{ topic: string; hex: string }> {
  const svc = globalThis.__enertrekMqtt;
  if (!svc) throw new Error("MQTT service not running");
  if (!svc.client.connected) throw new Error("MQTT broker is not connected — cannot send control frame");
  const topic = downlinkTopic(gateway.uid);
  const hex = frame.toString("hex");
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      svc.client.publish(topic, frame, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    }),
    new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Timed out publishing control frame (10s)")), 10_000)
    ),
  ]);
  return { topic, hex };
}

// ─── Downlink commands (C30) ─────────────────────────────────────────────────
export async function sendReadNow(gateway: Gateway, meterId: number): Promise<{ topic: string; hex: string }> {
  const svc = globalThis.__enertrekMqtt;
  if (!svc) throw new Error("MQTT service not running");
  if (gateway.transport !== "transparent") {
    throw new Error("On-demand reads are only available for C30 transparent gateways; G30 pushes JSON at its configured reporting interval.");
  }
  const db = getDb();
  const meterRows = await db.select().from(meters).where(eq(meters.id, meterId)).limit(1);
  const meter = meterRows[0];
  if (!meter || meter.gatewayId !== gateway.id) throw new Error("Meter not found on this gateway");

  const maps = await getRegisterMaps();
  const map = maps.get(meter.model);
  if (!map) throw new Error(`No register map for model ${meter.model}`);
  const span = registerSpan(map);
  if (!span) throw new Error("Register map span too large for a single Modbus read");

  const fc = map[0].functionCode;
  const frame = buildReadRequest(meter.modbusAddress, fc, span.start, span.quantity);
  const topic = downlinkTopic(gateway.uid);
  const hex = frame.toString("hex");

  if (!svc.client.connected) throw new Error("MQTT broker is not connected — cannot send on-demand read");
  // Publish with a hard timeout: if the broker connection stalls, the
  // publish callback never fires and this would otherwise hang forever.
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      svc.client.publish(topic, frame, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    }),
    new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Timed out publishing read-now command (10s)")), 10_000)
    ),
  ]);
  await db.insert(commands).values({
    gatewayId: gateway.id,
    meterId: meter.id,
    kind: "readNow",
    payloadHex: hex,
    topic,
    status: "sent",
  });
  return { topic, hex };
}
