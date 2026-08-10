// v8/D1 probe: automatic EMS strategies.
//  a) Schedule: create a discharge schedule covering NOW for the ESMU BESS
//     (127.0.0.1:5022, unit 1) → the controller (EMS_TICK_S=5) issues an
//     automatic FC6 setpoint; a commands row with userId null / status ok
//     appears; the sim register reads back the scaled value independently.
//  b) Peak shaving: config with thresholdKw=0.000001 against a probe source
//     meter with fresh import telemetry → automatic discharge command bounded
//     by maxDischargeKw; drop import to 0 → automatic stop (0 kW) command.
//  c) RBAC + cleanup of all probe artifacts.
//
// Requires the dev server running with EMS_TICK_S=5, plus the ESMU simulator
// on 5022. Run: npx tsx scripts/probe-v8-ems.ts
import "dotenv/config";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import ModbusRTU from "modbus-serial";
import { getDb } from "../api/queries/connection";
import { commands, deviceProfiles, emsPeakShaving, emsSchedules, gateways, meters, users } from "../db/schema";

const BASE = "http://localhost:3000";
const jars: Record<string, string> = {};

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
    const err = new Error(b.error.json?.message ?? b.error.message ?? JSON.stringify(b.error)) as Error & { httpStatus?: number };
    err.httpStatus = res.status;
    throw err;
  }
  return b.result.data.json;
}

const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

async function main() {
  const db = getDb();
  let fails = 0;
  const probe = (n: string, ok: boolean, d: unknown) => {
    console.log(ok ? "PASS" : "FAIL", n, "->", JSON.stringify(d).slice(0, 240));
    if (!ok) fails++;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ── setup ────────────────────────────────────────────────────────────────
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");
  const viewerEmail = "c12-viewer@enertrek.local"; // created by probe-v7
  const viewers = await db.select().from(users).where(eq(users.email, viewerEmail));
  if (viewers.length) await trpc("auth.login", { email: viewerEmail, password: "viewer1234" }, "viewer");

  // ESMU BESS (stack object) on the 5022 simulator.
  const esmuRows = await db
    .select()
    .from(meters)
    .where(and(eq(meters.model, "esmu-bams-stack"), eq(meters.port, 5022)))
    .limit(1);
  const esmu = esmuRows[0];
  if (!esmu) throw new Error("ESMU stack meter on port 5022 not found — start the sim: --esmu --port 5022 --strings 2");
  const esmuId = esmu.id;
  console.log("ESMU stack meter id:", esmuId);

  // Controllable whitelist for the ESMU profile (idempotent — like probe-v7).
  await db
    .update(deviceProfiles)
    .set({
      controllable: {
        activePowerKw: { address: 41000, fc: 6, min: 0, max: 250, scale: 10, unit: "kW", description: "PCS active power setpoint (+ = discharge)" },
      },
    })
    .where(eq(deviceProfiles.model, "esmu-bams-stack"));

  // Dedicated probe source meter for peak shaving (deterministic telemetry).
  const g = await db.insert(gateways).values({ uid: "gw-v8-probe", name: "v8", model: "TCP", transport: "tcp", topicPrefix: "-" }).$returningId();
  const srcIns = await db.insert(meters).values({ gatewayId: g[0].id, name: "v8 ps source", model: "PEM3000", modbusAddress: 7 }).$returningId();
  const srcId = srcIns[0].id;
  const t0 = new Date();

  // Command rows created after this id are probe/controller output.
  const maxIdRes = await db.execute(sql`select coalesce(max(id),0) as mx from commands`);
  const cmdIdAfter = Number((maxIdRes[0] as unknown as Array<{ mx: number }>)[0].mx);

  const autoCmds = async () =>
    db
      .select()
      .from(commands)
      .where(and(eq(commands.meterId, esmuId), isNull(commands.userId), sql`id > ${cmdIdAfter}`))
      .orderBy(desc(commands.id));

  const waitFor = async <T>(fn: () => Promise<T | null>, timeoutMs = 40000, stepMs = 2500): Promise<T | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(stepMs);
    }
  };

  let scheduleId = 0;
  let peakId = 0;
  try {
    // ── (a) schedule-driven discharge ──────────────────────────────────────
    const created = (await trpc(
      "ems.schedules.create",
      { meterId: esmuId, name: "v8-probe-discharge", dayOfWeekMask: 127, startMin: 0, endMin: 1440, mode: "discharge", targetKw: 2.5 },
      "admin",
    )) as { id: number };
    scheduleId = created.id;
    probe("schedule created via ems.schedules.create", scheduleId > 0, created);

    const schedCmd = await waitFor(async () => {
      const rows = (await autoCmds()).filter((c) => c.controlKey === "activePowerKw" && Math.abs((c.controlValue ?? 0) - 2.5) < 1e-9);
      return rows[0] ?? null;
    });
    probe("controller issued schedule setpoint (userId null, 2.5 kW)", schedCmd?.status === "ok", schedCmd && { status: schedCmd.status, v: schedCmd.controlValue, result: schedCmd.result });

    // independent read-back from the simulator (scale 10 → 25)
    const client = new ModbusRTU();
    await client.connectTCP("127.0.0.1", { port: 5022 });
    client.setID(1);
    client.setTimeout(5000);
    const reg = await client.readHoldingRegisters(41000, 1);
    await client.close(() => undefined);
    probe("simulator register 41000 == 25 (independent read)", reg.data?.[0] === 25, reg.data);

    // authed feed of automatic commands
    const feed = (await trpc("ems.autoCommands", { meterId: esmuId, limit: 10 }, "admin", "GET")) as Array<{ controlKey: string; controlValue: number; status: string }>;
    probe("ems.autoCommands feed shows the system command", feed.some((c) => c.controlKey === "activePowerKw" && c.controlValue === 2.5 && c.status === "ok"), feed.slice(0, 3));

    // viewer RBAC: read ok, create denied
    if (jars.viewer) {
      const vList = (await trpc("ems.schedules.list", { meterId: esmuId }, "viewer", "GET")) as unknown[];
      let denied = "";
      try {
        await trpc("ems.schedules.create", { meterId: esmuId, name: "x", dayOfWeekMask: 127, startMin: 0, endMin: 60, mode: "idle" }, "viewer");
      } catch (e) {
        denied = (e as Error).message;
      }
      probe("viewer: list allowed, create FORBIDDEN", Array.isArray(vList) && /Requires role/.test(denied), { listed: vList.length, denied });
    }

    // remove schedule before peak-shaving so the two strategies don't fight
    await trpc("ems.schedules.remove", { id: scheduleId }, "admin");
    scheduleId = 0;

    // ── (b) peak shaving ───────────────────────────────────────────────────
    await db.execute(sql`insert into telemetry (meter_id, ts, active_power_kw) values (${srcId}, ${utcStr(new Date())}, 12.3)`);
    const pc = (await trpc(
      "ems.peakShaving.create",
      { sourceMeterId: srcId, bessMeterId: esmuId, thresholdKw: 0.000001, hysteresisKw: 0.0000005, maxDischargeKw: 5 },
      "admin",
    )) as { id: number };
    peakId = pc.id;
    probe("peak-shaving config created", peakId > 0, pc);

    const shaveCmd = await waitFor(async () => {
      const rows = (await autoCmds()).filter((c) => c.controlKey === "activePowerKw" && Math.abs((c.controlValue ?? 0) - 5) < 1e-9);
      return rows[0] ?? null;
    });
    probe(
      "peak shaving: auto discharge bounded by maxDischargeKw (5 kW)",
      shaveCmd?.status === "ok" && Math.abs((shaveCmd.controlValue ?? 0) - 5) < 1e-9,
      shaveCmd && { status: shaveCmd.status, v: shaveCmd.controlValue, result: shaveCmd.result },
    );

    // import collapses → stop command (0 kW), hysteresis path
    await db.execute(sql`insert into telemetry (meter_id, ts, active_power_kw) values (${srcId}, ${utcStr(new Date())}, 0)`);
    const stopCmd = await waitFor(async () => {
      const rows = (await autoCmds()).filter((c) => c.controlKey === "activePowerKw" && (c.controlValue ?? -1) === 0);
      return rows[0] ?? null;
    });
    probe("peak shaving: stop command (0 kW) below threshold − hysteresis", stopCmd?.status === "ok", stopCmd && { status: stopCmd.status, v: stopCmd.controlValue });

    // disable after
    await trpc("ems.peakShaving.update", { id: peakId, patch: { enabled: false } }, "admin");
    const after = (await trpc("ems.peakShaving.list", { bessMeterId: esmuId }, "admin", "GET")) as Array<{ id: number; enabled: boolean }>;
    probe("peak-shaving config disabled via update", after.find((c) => c.id === peakId)?.enabled === false, after);
  } finally {
    // ── (c) cleanup ────────────────────────────────────────────────────────
    if (scheduleId) await db.delete(emsSchedules).where(eq(emsSchedules.id, scheduleId)).catch(() => undefined);
    if (peakId) await db.delete(emsPeakShaving).where(eq(emsPeakShaving.id, peakId)).catch(() => undefined);
    await db.execute(sql`delete from telemetry where meter_id = ${srcId} and ts >= ${utcStr(t0)}`).catch(() => undefined);
    await db.delete(meters).where(eq(meters.id, srcId)).catch(() => undefined);
    await db.delete(gateways).where(eq(gateways.id, g[0].id)).catch(() => undefined);
  }

  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
