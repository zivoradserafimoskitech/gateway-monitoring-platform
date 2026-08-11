// v9 Contract A probe: EMS plan push + controller execution.
//  1) PUT plan (now−1min … +20min; +2.5 kW for the first 10 min, then 0) via
//     API key → 200, superseded=0.
//  2) Controller executes the plan setpoint: commands row userId null with
//     result prefixed `plan:volttrade-test`; sim register 41000 reads back 25.
//  3) Step-down to 0 kW at the second setpoint executes (register 0) — proves
//     the step function.
//  4) Overlapping PUT supersedes (superseded=1; GET returns the new plan;
//     old plan row superseded in DB).
//  5) Stale plan (validTo in the past) is NOT executed (no new command) and is
//     lazily marked expired by the per-tick sweep.
//  6) Peak-shaving override: with an active plan + aggressive peak config, the
//     peak command wins and the plan does not overwrite it while active.
//  7) 404 for a device of another org; 400 on bad span / unsorted / >192
//     setpoints (plus >48h span, out-of-window ts, |kw|>500); 401 without key.
//  8) Cleanup of all artifacts (plans, peak config, source meter/gateway/org,
//     probe API key) + register reset.
//
// Requires the dev server on :3000 with EMS_TICK_S=5 and the ESMU simulator
// on 5022. Runtime ~11 min (check 3 waits for the real step-down).
// Run: npx tsx scripts/probe-v9-ems-plan.ts
import "dotenv/config";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import ModbusRTU from "modbus-serial";
import { getDb } from "../api/queries/connection";
import { commands, deviceProfiles, emsPeakShaving, gateways, meters, orgs } from "../db/schema";

const BASE = "http://localhost:3000";
const jars: Record<string, string> = {};
const SOURCE = "volttrade-test";

let fails = 0;
function probe(name: string, ok: boolean, detail: unknown): void {
  console.log(ok ? "PASS" : "FAIL", name, "->", JSON.stringify(detail).slice(0, 240));
  if (!ok) fails++;
}

async function trpc(proc: string, payload: unknown, who?: string): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who && jars[who]) headers.cookie = jars[who];
  const res = await fetch(`${BASE}/api/trpc/${proc}?batch=1`, {
    method: "POST",
    headers,
    body: JSON.stringify({ "0": { json: payload } }),
  });
  const setCookie = res.headers.get("set-cookie");
  if (who && setCookie) jars[who] = setCookie.split(";")[0];
  const body = await res.json();
  const b = Array.isArray(body) ? body[0] : body;
  if (b.error) throw new Error(b.error.json?.message ?? JSON.stringify(b.error));
  return b.result.data.json;
}

async function v1(method: string, path: string, key?: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 60000, stepMs = 2500): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

async function readRegister(): Promise<number | null> {
  const client = new ModbusRTU();
  try {
    await client.connectTCP("127.0.0.1", { port: 5022 });
    client.setID(1);
    client.setTimeout(5000);
    const reg = await client.readHoldingRegisters(41000, 1);
    return reg.data?.[0] ?? null;
  } finally {
    await client.close(() => undefined);
  }
}

async function writeRegister(value: number): Promise<void> {
  const client = new ModbusRTU();
  try {
    await client.connectTCP("127.0.0.1", { port: 5022 });
    client.setID(1);
    client.setTimeout(5000);
    await client.writeRegister(41000, value);
  } finally {
    await client.close(() => undefined);
  }
}

async function main() {
  const db = getDb();

  // ── setup ────────────────────────────────────────────────────────────────
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");
  const key = (await trpc("apiKeys.create", { name: "probe-v9-ems-plan", role: "viewer" }, "admin")) as { id: number; key: string };
  const raw = key.key;

  const esmuRows = await db
    .select()
    .from(meters)
    .where(and(eq(meters.model, "esmu-bams-stack"), eq(meters.port, 5022)))
    .limit(1);
  const esmu = esmuRows[0];
  if (!esmu) throw new Error("ESMU stack meter on port 5022 not found — start the sim: --esmu --port 5022 --strings 2");
  const esmuId = esmu.id;
  console.log("ESMU stack meter id:", esmuId);

  // Controllable whitelist for the ESMU profile (idempotent — like probe-v8).
  await db
    .update(deviceProfiles)
    .set({
      controllable: {
        activePowerKw: { address: 41000, fc: 6, min: 0, max: 250, scale: 10, unit: "kW", description: "PCS active power setpoint (+ = discharge)" },
      },
    })
    .where(eq(deviceProfiles.model, "esmu-bams-stack"));

  // Baseline: register 0 and a command-id high-water mark.
  await writeRegister(0);
  const maxIdRes = await db.execute(sql`select coalesce(max(id),0) as mx from commands`);
  const cmdIdAfter = Number((maxIdRes[0] as unknown as Array<{ mx: number }>)[0].mx);

  const autoCmds = async () =>
    db
      .select()
      .from(commands)
      .where(and(eq(commands.meterId, esmuId), isNull(commands.userId), sql`id > ${cmdIdAfter}`))
      .orderBy(desc(commands.id));

  const planRows = async () => {
    const r = await db.execute(sql`select id, source, status, date_format(valid_from, '%Y-%m-%dT%H:%i:%sZ') as vf, date_format(valid_to, '%Y-%m-%dT%H:%i:%sZ') as vt from ems_plans where meter_id = ${esmuId} order by id`);
    return r[0] as unknown as Array<{ id: number; source: string; status: string; vf: string; vt: string }>;
  };

  let planId1 = 0;
  let planId2 = 0;
  let staleId = 0;
  let peakId = 0;
  let gwId = 0;
  let srcId = 0;
  let orgId = 0;
  let orgMeterId = 0;
  try {
    // ── (1) PUT plan → 200, superseded=0 ───────────────────────────────────
    const t0 = Date.now();
    const vf = new Date(t0 - 60_000);
    const stepTs = new Date(vf.getTime() + 10 * 60_000); // +2.5 kW until here
    const vt = new Date(t0 + 20 * 60_000);
    const plan1Body = {
      validFrom: vf.toISOString(),
      validTo: vt.toISOString(),
      source: SOURCE,
      setpoints: [
        { ts: vf.toISOString(), kw: 2.5 },
        { ts: stepTs.toISOString(), kw: 0 },
      ],
    };
    const put1 = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, plan1Body);
    planId1 = put1.body?.planId ?? 0;
    probe("(1) PUT plan → 200, superseded=0", put1.status === 200 && put1.body?.status === "active" && put1.body?.superseded === 0 && planId1 > 0, put1);

    // ── (2) controller executes the plan setpoint ──────────────────────────
    const cmd2 = await waitFor(async () => {
      const rows = (await autoCmds()).filter(
        (c) => c.controlKey === "activePowerKw" && Math.abs((c.controlValue ?? 0) - 2.5) < 1e-9 && (c.result ?? "").startsWith(`plan:${SOURCE}`),
      );
      return rows[0] ?? null;
    });
    probe(
      "(2) plan setpoint executed (userId null, result plan:volttrade-test, 2.5 kW)",
      cmd2?.status === "ok",
      cmd2 && { status: cmd2.status, v: cmd2.controlValue, result: cmd2.result },
    );
    const reg2 = await readRegister();
    probe("(2) simulator register 41000 == 25 (independent read)", reg2 === 25, reg2);

    // ── (3) step-down to 0 kW at the second setpoint ───────────────────────
    const waitMs = stepTs.getTime() - Date.now();
    if (waitMs > 0) {
      console.log(`… waiting ${Math.round(waitMs / 1000)}s for the step-down at ${stepTs.toISOString()}`);
      await sleep(waitMs);
    }
    const cmd3 = await waitFor(async () => {
      const rows = (await autoCmds()).filter((c) => c.controlKey === "activePowerKw" && (c.controlValue ?? -1) === 0 && (c.result ?? "").startsWith(`plan:${SOURCE}`));
      return rows[0] ?? null;
    }, 120_000);
    probe("(3) step-down to 0 kW executed (step function)", cmd3?.status === "ok", cmd3 && { status: cmd3.status, v: cmd3.controlValue, result: cmd3.result });
    const reg3 = await readRegister();
    probe("(3) simulator register 41000 == 0 after step-down", reg3 === 0, reg3);

    // ── (4) overlapping PUT supersedes ─────────────────────────────────────
    const t4 = Date.now();
    const plan2Body = {
      validFrom: new Date(t4).toISOString(),
      validTo: new Date(t4 + 10 * 60_000).toISOString(),
      source: SOURCE,
      setpoints: [{ ts: new Date(t4).toISOString(), kw: 0 }],
    };
    const put2 = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, plan2Body);
    planId2 = put2.body?.planId ?? 0;
    const get4 = await v1("GET", `/devices/${esmuId}/ems-plan`, raw);
    const rows4 = await planRows();
    probe(
      "(4) overlapping PUT → superseded=1, GET returns the new plan, old row superseded",
      put2.status === 200 &&
        put2.body?.superseded === 1 &&
        get4.body?.plan?.id === planId2 &&
        get4.body?.plan?.status === "active" &&
        rows4.find((r) => r.id === planId1)?.status === "superseded",
      { put2: put2.body, getPlan: get4.body?.plan?.id, rows: rows4 },
    );

    // ── (5) stale plan: not executed + lazily expired ──────────────────────
    const marker5 = Number(((await db.execute(sql`select coalesce(max(id),0) as mx from commands`))[0] as unknown as Array<{ mx: number }>)[0].mx);
    const staleBody = {
      validFrom: new Date(t4 - 30 * 60_000).toISOString(),
      validTo: new Date(t4 - 20 * 60_000).toISOString(),
      source: SOURCE,
      setpoints: [{ ts: new Date(t4 - 30 * 60_000).toISOString(), kw: 1.0 }],
    };
    const putStale = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, staleBody);
    staleId = putStale.body?.planId ?? 0;
    await sleep(13_000); // >2 controller ticks (EMS_TICK_S=5)
    const cmds5 = await db
      .select()
      .from(commands)
      .where(and(eq(commands.meterId, esmuId), sql`id > ${marker5}`));
    const rows5 = await planRows();
    probe(
      "(5) stale plan accepted but NOT executed; lazily marked expired",
      putStale.status === 200 &&
        putStale.body?.superseded === 0 &&
        !cmds5.some((c) => Math.abs((c.controlValue ?? 0) - 1.0) < 1e-9) &&
        rows5.find((r) => r.id === staleId)?.status === "expired",
      { putStale: putStale.body, cmdsAfterMarker: cmds5.length, stale: rows5.find((r) => r.id === staleId) },
    );

    // ── (6) peak-shaving override wins over the active plan ────────────────
    const g = await db.insert(gateways).values({ uid: "gw-v9-probe", name: "v9", model: "TCP", transport: "tcp", topicPrefix: "-" }).$returningId();
    gwId = g[0].id;
    const srcIns = await db.insert(meters).values({ gatewayId: gwId, name: "v9 ps source", model: "PEM3000", modbusAddress: 7 }).$returningId();
    srcId = srcIns[0].id;
    await db.execute(sql`insert into telemetry (meter_id, ts, active_power_kw) values (${srcId}, ${utcStr(new Date())}, 12.3)`);
    const pc = (await trpc(
      "ems.peakShaving.create",
      { sourceMeterId: srcId, bessMeterId: esmuId, thresholdKw: 0.000001, hysteresisKw: 0.0000005, maxDischargeKw: 5 },
      "admin",
    )) as { id: number };
    peakId = pc.id;
    const marker6 = Number(((await db.execute(sql`select coalesce(max(id),0) as mx from commands`))[0] as unknown as Array<{ mx: number }>)[0].mx);
    const cmd6 = await waitFor(async () => {
      const rows = await db
        .select()
        .from(commands)
        .where(and(eq(commands.meterId, esmuId), isNull(commands.userId), sql`id > ${marker6}`, sql`abs(control_value - 5) < 0.000000001`))
        .orderBy(desc(commands.id));
      return rows[0] ?? null;
    });
    probe("(6) peak shaving fired over the active plan (5 kW command)", cmd6?.status === "ok", cmd6 && { status: cmd6.status, v: cmd6.controlValue, result: cmd6.result });
    // While the peak event persists (2+ ticks), the plan must not overwrite it.
    await sleep(12_000);
    const reg6 = await readRegister();
    const overwrite = await db
      .select()
      .from(commands)
      .where(and(eq(commands.meterId, esmuId), sql`id > ${cmd6?.id ?? marker6}`, sql`control_value = 0`));
    probe("(6) peak holds: register stays 50, plan does not overwrite", reg6 === 50 && overwrite.length === 0, { reg: reg6, overwriteCmds: overwrite.length });
    // stand down: kill the peak event so the rest of the probe is quiet
    await db.delete(emsPeakShaving).where(eq(emsPeakShaving.id, peakId));
    peakId = 0;
    await db.execute(sql`insert into telemetry (meter_id, ts, active_power_kw) values (${srcId}, ${utcStr(new Date())}, 0)`);

    // ── (7) org scoping + validation ───────────────────────────────────────
    const o = await db.insert(orgs).values({ name: "v9-probe-org" }).$returningId();
    orgId = o[0].id;
    const om = await db.insert(meters).values({ gatewayId: gwId, name: "v9 other-org meter", model: "PEM3000", modbusAddress: 8, orgId }).$returningId();
    orgMeterId = om[0].id;
    const otherPut = await v1("PUT", `/devices/${orgMeterId}/ems-plan`, raw, plan1Body);
    const otherGet = await v1("GET", `/devices/${orgMeterId}/ems-plan`, raw);
    const badSpan = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, { validFrom: vt.toISOString(), validTo: vf.toISOString(), setpoints: [{ ts: vf.toISOString(), kw: 1 }] });
    const longSpan = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, {
      validFrom: vf.toISOString(),
      validTo: new Date(vf.getTime() + 49 * 3_600_000).toISOString(),
      setpoints: [{ ts: vf.toISOString(), kw: 1 }],
    });
    const unsorted = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, {
      validFrom: vf.toISOString(),
      validTo: vt.toISOString(),
      setpoints: [
        { ts: stepTs.toISOString(), kw: 1 },
        { ts: vf.toISOString(), kw: 1 },
      ],
    });
    const tooMany = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, {
      validFrom: vf.toISOString(),
      validTo: new Date(vf.getTime() + 24 * 3_600_000).toISOString(),
      setpoints: Array.from({ length: 193 }, (_, i) => ({ ts: new Date(vf.getTime() + i * 5 * 60_000).toISOString(), kw: 1 })),
    });
    const outOfWindow = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, { validFrom: vf.toISOString(), validTo: vt.toISOString(), setpoints: [{ ts: new Date(vt.getTime() + 60_000).toISOString(), kw: 1 }] });
    const tooBig = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, { validFrom: vf.toISOString(), validTo: vt.toISOString(), setpoints: [{ ts: vf.toISOString(), kw: 501 }] });
    const noKey = await v1("GET", `/devices/${esmuId}/ems-plan`);
    probe(
      "(7) 404 other-org device (PUT+GET); 400 bad span/>48h/unsorted/>192/out-of-window/|kw|>500; 401 no key",
      otherPut.status === 404 &&
        otherGet.status === 404 &&
        badSpan.status === 400 &&
        longSpan.status === 400 &&
        unsorted.status === 400 &&
        tooMany.status === 400 &&
        outOfWindow.status === 400 &&
        tooBig.status === 400 &&
        noKey.status === 401,
      { otherPut: otherPut.status, otherGet: otherGet.status, badSpan: badSpan.status, longSpan: longSpan.status, unsorted: unsorted.status, tooMany: tooMany.status, outOfWindow: outOfWindow.status, tooBig: tooBig.status, noKey: noKey.status },
    );
  } finally {
    // ── (8) cleanup ────────────────────────────────────────────────────────
    if (peakId) await db.delete(emsPeakShaving).where(eq(emsPeakShaving.id, peakId)).catch(() => undefined);
    await db.execute(sql`delete from ems_plans where meter_id = ${esmuId} and source = ${SOURCE}`).catch(() => undefined);
    if (srcId) {
      await db.execute(sql`delete from telemetry where meter_id = ${srcId}`).catch(() => undefined);
      await db.delete(meters).where(eq(meters.id, srcId)).catch(() => undefined);
    }
    if (orgMeterId) await db.delete(meters).where(eq(meters.id, orgMeterId)).catch(() => undefined);
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId)).catch(() => undefined);
    if (gwId) await db.delete(gateways).where(eq(gateways.id, gwId)).catch(() => undefined);
    await trpc("apiKeys.revoke", { id: key.id }, "admin").catch(() => undefined);
    await writeRegister(0).catch(() => undefined);
    const left = await planRows();
    const keyCheck = await v1("GET", `/devices/${esmuId}/ems-plan`, raw);
    probe("(8) cleanup: plans gone, key revoked, register reset", left.length === 0 && keyCheck.status === 401, { plansLeft: left.length, keyStatus: keyCheck.status });
  }

  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
