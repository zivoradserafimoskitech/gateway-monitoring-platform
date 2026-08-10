// v8/D5: OTA job manager — firmware + config delivery to gateways.
//
// Protocol (MQTT gateways, JSON or transparent transport):
//   cmd  → g2d/<uid>/ota   {"jobId":N,"type":"firmware|config","payload":{...}}
//   ack  ← d2g/<uid>/ota   {"jobId":N,"status":"ack"|"failed","error"?,
//                           "firmwareVersion"?}   (acked frames also count as
//                           liveness — service.ts marks the gateway seen)
// Status machine: pending → sent (frame published) → ack | failed.
//   failed = ack timeout (60 s), negative ack, unsupported operation, or
//   cancel. Each (re)dispatch bumps attempts; > 3 attempts → failed.
//
// TCP/direct gateways (transport "tcp", polled by the poller): config push is
// applied via the C12 whitelisted FC6 path (payload {"controlKey","value",
// "meterId?"}); firmware OTA has no downlink channel → job fails immediately
// with a clear error.
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { gateways, meters, otaJobs } from "@db/schema";
import type { Gateway, OtaJob } from "@db/schema";
import { executeAndLog, ControlError } from "../control/execute";
import { publishOtaCmd } from "../mqtt/service";

const ACK_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const SWEEP_MS = 15_000;

let timer: NodeJS.Timeout | null = null;

export function startOtaLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    otaSweep().catch((err) => console.error("[ota] sweep failed:", err instanceof Error ? err.message : err));
  }, SWEEP_MS);
  timer.unref?.();
  console.log("[ota] manager started");
}

// ─── Dispatch ────────────────────────────────────────────────────────────────
async function failJob(jobId: number, error: string): Promise<void> {
  await getDb().update(otaJobs).set({ status: "failed", error }).where(eq(otaJobs.id, jobId));
  console.warn(`[ota] job ${jobId} failed: ${error}`);
}

/** Config push over the C12 whitelisted FC6 path for TCP/direct gateways. */
async function applyTcpConfig(gw: Gateway, job: OtaJob): Promise<void> {
  const p = job.payload as { controlKey?: string; value?: number; meterId?: number };
  if (typeof p.controlKey !== "string" || typeof p.value !== "number") {
    await failJob(job.id, "TCP config push requires payload {controlKey, value, meterId?} (C12 whitelisted key)");
    return;
  }
  const db = getDb();
  const meterRows = p.meterId != null
    ? await db.select().from(meters).where(and(eq(meters.id, p.meterId), eq(meters.gatewayId, gw.id))).limit(1)
    : await db.select().from(meters).where(eq(meters.gatewayId, gw.id)).limit(1);
  const meter = meterRows[0];
  if (!meter) {
    await failJob(job.id, "No meter on this gateway to apply the config to");
    return;
  }
  try {
    const res = await executeAndLog(meter, p.controlKey, p.value, null);
    await db.update(otaJobs).set({ status: "ack", ackAt: new Date(), attempts: job.attempts + 1, sentAt: new Date(), error: null }).where(eq(otaJobs.id, job.id));
    await db.update(gateways).set({ configVersion: sql`${gateways.configVersion} + 1` }).where(eq(gateways.id, gw.id));
    console.log(`[ota] job ${job.id} TCP config applied: ${meter.name} ${p.controlKey}=${p.value} (${res.status})`);
  } catch (err) {
    await failJob(job.id, err instanceof ControlError ? err.message : `TCP config push failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function dispatch(job: OtaJob): Promise<void> {
  const db = getDb();
  const gwRows = await db.select().from(gateways).where(eq(gateways.id, job.gatewayId)).limit(1);
  const gw = gwRows[0];
  if (!gw) {
    await failJob(job.id, "Gateway no longer exists");
    return;
  }
  if (gw.transport === "tcp") {
    if (job.type === "firmware") {
      await failJob(job.id, "Firmware OTA is not supported for TCP/direct gateways — no downlink channel (config push only)");
      return;
    }
    await applyTcpConfig(gw, job);
    return;
  }
  try {
    const frame = { jobId: job.id, type: job.type, payload: job.payload };
    const { topic } = await publishOtaCmd(gw, frame);
    await db
      .update(otaJobs)
      .set({ status: "sent", sentAt: new Date(), attempts: job.attempts + 1, error: null })
      .where(eq(otaJobs.id, job.id));
    console.log(`[ota] job ${job.id} (${job.type}) → ${topic} (attempt ${job.attempts + 1})`);
  } catch (err) {
    await failJob(job.id, `publish failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function otaSweep(): Promise<void> {
  try {
    const db = getDb();
    const pending = await db.select().from(otaJobs).where(eq(otaJobs.status, "pending"));
    for (const job of pending) await dispatch(job);
    // Ack timeouts: retry until MAX_ATTEMPTS dispatches, then failed.
    const timedOut = await db
      .select()
      .from(otaJobs)
      .where(and(eq(otaJobs.status, "sent"), lt(otaJobs.sentAt, new Date(Date.now() - ACK_TIMEOUT_MS))));
    for (const job of timedOut) {
      if (job.attempts >= MAX_ATTEMPTS) {
        await failJob(job.id, `ack timeout after ${job.attempts} attempts`);
      } else {
        console.warn(`[ota] job ${job.id} ack timeout — redispatching (attempt ${job.attempts + 1})`);
        await dispatch(job);
      }
    }
  } catch (err) {
    console.error("[ota] sweep error:", err instanceof Error ? err.message : err);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────
export async function createOtaJob(input: {
  gatewayId: number;
  type: "firmware" | "config";
  payload: Record<string, unknown>;
  createdBy: number | null;
}): Promise<OtaJob> {
  const db = getDb();
  // v8/D2: stamp the job with the gateway's org.
  const gwOrg = await db.select({ orgId: gateways.orgId }).from(gateways).where(eq(gateways.id, input.gatewayId)).limit(1);
  const ins = await db
    .insert(otaJobs)
    .values({ gatewayId: input.gatewayId, type: input.type, payload: input.payload, createdBy: input.createdBy, orgId: gwOrg[0]?.orgId ?? null })
    .$returningId();
  const rows = await db.select().from(otaJobs).where(eq(otaJobs.id, ins[0].id)).limit(1);
  const job = rows[0];
  // Best-effort immediate dispatch; the sweep retries/handles failures.
  await dispatch(job).catch((err) => console.error(`[ota] job ${job.id} dispatch error:`, err instanceof Error ? err.message : err));
  const after = await db.select().from(otaJobs).where(eq(otaJobs.id, job.id)).limit(1);
  return after[0];
}

export async function cancelOtaJob(id: number): Promise<{ ok: true } | { error: string }> {
  const db = getDb();
  const res = await db
    .update(otaJobs)
    .set({ status: "failed", error: "cancelled by operator" })
    .where(and(eq(otaJobs.id, id), eq(otaJobs.status, "pending")));
  if ((res[0] as { affectedRows?: number }).affectedRows === 0) return { error: "Job not found or no longer pending" };
  return { ok: true };
}

/** Ack handler — wired from mqtt/service.ts onMessage for d2g/<uid>/ota frames. */
export async function handleOtaAck(gw: Gateway, payload: Buffer): Promise<void> {
  let frame: { jobId?: unknown; status?: unknown; error?: unknown; firmwareVersion?: unknown };
  try {
    frame = JSON.parse(payload.toString("utf8"));
  } catch {
    console.warn(`[ota] non-JSON ota frame from ${gw.uid} ignored`);
    return;
  }
  const jobId = Number(frame.jobId);
  if (!Number.isInteger(jobId)) return;
  const db = getDb();
  const rows = await db.select().from(otaJobs).where(eq(otaJobs.id, jobId)).limit(1);
  const job = rows[0];
  if (!job || job.gatewayId !== gw.id) {
    console.warn(`[ota] ack for unknown/foreign job ${jobId} from ${gw.uid} ignored`);
    return;
  }
  if (job.status !== "sent") return; // stale ack (already acked/failed/cancelled)
  if (frame.status === "ack") {
    await db.update(otaJobs).set({ status: "ack", ackAt: new Date(), error: null }).where(eq(otaJobs.id, jobId));
    if (job.type === "firmware") {
      const version = typeof frame.firmwareVersion === "string"
        ? frame.firmwareVersion
        : typeof (job.payload as { version?: unknown }).version === "string"
          ? (job.payload as { version: string }).version
          : null;
      if (version) await db.update(gateways).set({ firmwareVersion: version }).where(eq(gateways.id, gw.id));
    } else {
      await db.update(gateways).set({ configVersion: sql`${gateways.configVersion} + 1` }).where(eq(gateways.id, gw.id));
    }
    console.log(`[ota] job ${jobId} acked by ${gw.uid}`);
  } else {
    await failJob(jobId, typeof frame.error === "string" ? frame.error : "negative ack from gateway");
  }
}

/** Count of active (in-flight) jobs for diagnostics. */
export async function activeOtaJobs(gatewayId: number): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(otaJobs)
    .where(and(eq(otaJobs.gatewayId, gatewayId), inArray(otaJobs.status, ["pending", "sent"])));
  return Number(rows[0]?.n ?? 0);
}
