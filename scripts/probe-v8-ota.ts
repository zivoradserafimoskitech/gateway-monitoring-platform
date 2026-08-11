// v8/D5 probe: device management — OTA jobs + heartbeat diagnostics.
//  1. temp G30 gateway (gw-v8-ota-probe) → config OTA job → simulator receives
//     g2d/<uid>/ota → acks d2g/<uid>/ota → job becomes ack, configVersion++.
//  2. firmware job over MQTT → ack + gateway firmwareVersion updated (D5.1).
//  3. diagnostics: temp gateway lastSeenAt set by the ack; live demo gateway 1
//     reports msgPerMin > 0; TCP gateway 30001 exposes poller stats.
//  4. firmware job to TCP/direct gateway 30001 → failed with a clear error.
//  5. viewer → FORBIDDEN on ota.create.
//  6. cleanup: jobs + temp gateway removed.
// Requires: dev server on :3000, broker on :1883, scripts/simulator.ts running.
// Run: npx tsx scripts/probe-v8-ota.ts
import "dotenv/config";
import fs from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { gateways, otaJobs, users } from "../db/schema";

const BASE = "http://localhost:3000";
const jars: Record<string, string> = {};
const TEMP_UID = "gw-v8-ota-probe";

let fails = 0;
function probe(name: string, ok: boolean, detail: unknown): void {
  console.log(ok ? "PASS" : "FAIL", name, "->", JSON.stringify(detail).slice(0, 240));
  if (!ok) fails++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function trpc(proc: string, payload: unknown, who?: string, method: "POST" | "GET" = "POST"): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who && jars[who]) headers.cookie = jars[who];
  let url = `${BASE}/api/trpc/${proc}?batch=1`;
  const init: RequestInit = { method, headers };
  if (method === "POST") init.body = JSON.stringify({ "0": { json: payload } });
  else url += `&input=${encodeURIComponent(JSON.stringify({ "0": { json: payload } }))}`;
  const res = await fetch(url, init);
  const setCookie = res.headers.get("set-cookie");
  if (who && setCookie) jars[who] = setCookie.split(";")[0];
  const body = await res.json();
  const b = Array.isArray(body) ? body[0] : body;
  if (b.error) {
    const err = new Error(b.error.json?.message ?? JSON.stringify(b.error)) as Error & { httpStatus?: number };
    err.httpStatus = res.status;
    throw err;
  }
  return b.result.data.json;
}

interface Job { id: number; status: string; attempts: number; error: string | null; ackAt: string | null; sentAt: string | null }

async function waitJob(id: number, timeoutMs = 25000): Promise<Job | null> {
  const db = getDb();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.select().from(otaJobs).where(eq(otaJobs.id, id)).limit(1);
    if (rows[0] && rows[0].status !== "pending" && rows[0].status !== "sent") return rows[0] as unknown as Job;
    if (Date.now() > deadline) return (rows[0] as unknown as Job) ?? null;
    await sleep(1000);
  }
}

async function main() {
  const db = getDb();
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");
  const viewerEmail = "c12-viewer@enertrek.local";
  const viewers = await db.select().from(users).where(eq(users.email, viewerEmail));
  if (viewers.length) await trpc("auth.login", { email: viewerEmail, password: "viewer1234" }, "viewer");

  let tempGwId = 0;
  const jobIds: number[] = [];
  try {
    // temp G30 gateway (cloud side); the simulator acks any g2d/+/ota frame.
    const gw = (await trpc("gateways.create", { uid: TEMP_UID, name: "v8 OTA probe", model: "G30" }, "admin")) as { id: number };
    tempGwId = gw.id;
    probe("temp G30 gateway created", tempGwId > 0, { tempGwId });

    // ── 1. config job end-to-end ───────────────────────────────────────────
    const cj = (await trpc("ota.create", { gatewayId: tempGwId, type: "config", payload: { pollIntervalMs: 15000 } }, "admin")) as Job;
    jobIds.push(cj.id);
    const cjFinal = await waitJob(cj.id);
    const simLog = fs.existsSync("/tmp/sim-mqtt.log") ? fs.readFileSync("/tmp/sim-mqtt.log", "utf8") : "";
    const simGot = simLog.includes(`OTA cmd uid=${TEMP_UID} type=config job=${cj.id}`);
    const gwAfter = await db.select().from(gateways).where(eq(gateways.id, tempGwId)).limit(1);
    probe(
      "config job: simulator received frame → ack → job ack, configVersion bumped",
      cjFinal?.status === "ack" && cjFinal.attempts === 1 && !!cjFinal.ackAt && simGot && gwAfter[0]?.configVersion === 2,
      { status: cjFinal?.status, attempts: cjFinal?.attempts, simGot, configVersion: gwAfter[0]?.configVersion },
    );

    // ── 2. firmware job over MQTT (D5.1: firmwareVersion shown in UI data) ─
    const fj = (await trpc("ota.create", { gatewayId: tempGwId, type: "firmware", payload: { version: "1.4.2", url: "https://fw.example.com/g30-1.4.2.bin" } }, "admin")) as Job;
    jobIds.push(fj.id);
    const fjFinal = await waitJob(fj.id);
    const gwFw = await db.select().from(gateways).where(eq(gateways.id, tempGwId)).limit(1);
    probe(
      "firmware job: ack + gateway firmwareVersion = 1.4.2",
      fjFinal?.status === "ack" && gwFw[0]?.firmwareVersion === "1.4.2",
      { status: fjFinal?.status, fw: gwFw[0]?.firmwareVersion },
    );

    // ── 3. diagnostics ─────────────────────────────────────────────────────
    // Liveness flush е batch на 5 s (api/mqtt/liveness.ts) — ack-от го маркира
    // gateway-ot веднаш, но DB редот се пишува на следниот flush циклус. Poll
    // до 15 s наместо еден ран read (race: брз ack < flush интервал).
    let diagTemp = (await trpc("gateways.diagnostics", { id: tempGwId }, "admin", "GET")) as { lastSeenAt: string | null; msgPerMin: number; activeOtaJobs: number };
    for (let i = 0; i < 7 && !diagTemp.lastSeenAt; i++) {
      await new Promise((r) => setTimeout(r, 2200));
      diagTemp = (await trpc("gateways.diagnostics", { id: tempGwId }, "admin", "GET")) as { lastSeenAt: string | null; msgPerMin: number; activeOtaJobs: number };
    }
    const diagLive = (await trpc("gateways.diagnostics", { id: 1 }, "admin", "GET")) as { lastSeenAt: string | null; msgPerMin: number; samples5min: number };
    const diagTcp = (await trpc("gateways.diagnostics", { id: 30001 }, "admin", "GET")) as { poller: Array<{ id: number; polls: number }> | null };
    probe(
      "diagnostics: temp gw lastSeenAt set (ack = liveness), live gw msgPerMin > 0, TCP poller stats",
      !!diagTemp.lastSeenAt && diagTemp.activeOtaJobs === 0 && diagLive.msgPerMin > 0 && Array.isArray(diagTcp.poller) && diagTcp.poller.length > 0,
      { tempSeen: diagTemp.lastSeenAt, liveMsgPerMin: diagLive.msgPerMin, tcpPollerDevices: diagTcp.poller?.length },
    );

    // ── 4. firmware to TCP/direct gateway → clear failure ──────────────────
    const tj = (await trpc("ota.create", { gatewayId: 30001, type: "firmware", payload: { version: "2.0.0", url: "https://x" } }, "admin")) as Job;
    jobIds.push(tj.id);
    probe(
      "firmware job to TCP gateway → failed with clear error",
      tj.status === "failed" && /not supported for TCP/.test(tj.error ?? ""),
      { status: tj.status, error: tj.error },
    );

    // ── 5. viewer forbidden ────────────────────────────────────────────────
    if (jars.viewer) {
      let denied = "";
      try {
        await trpc("ota.create", { gatewayId: tempGwId, type: "config", payload: {} }, "viewer");
      } catch (e) {
        denied = (e as Error).message;
      }
      const vList = await trpc("ota.list", { gatewayId: tempGwId }, "viewer", "GET");
      probe("viewer: list allowed, create FORBIDDEN", Array.isArray(vList) && /Requires role/.test(denied), { denied });
    }
  } finally {
    // ── 6. cleanup ─────────────────────────────────────────────────────────
    if (jobIds.length) await db.delete(otaJobs).where(inArray(otaJobs.id, jobIds)).catch(() => undefined);
    if (tempGwId) await trpc("gateways.remove", { id: tempGwId }, "admin").catch(() => undefined);
    const gone = await db.select().from(gateways).where(and(eq(gateways.uid, TEMP_UID))).limit(1);
    if (gone.length) await db.delete(gateways).where(eq(gateways.uid, TEMP_UID)).catch(() => undefined);
  }

  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

