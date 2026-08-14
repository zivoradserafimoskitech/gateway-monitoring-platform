/**
 * probe-v9-e2e-integration.ts — v9 INT.1: целосен интеграциски ланец end-to-end.
 *
 *   VoltTrade optimizePortfolio → pushEmsPlan → Enertrek REST PUT/GET
 *   → emsController tick → Modbus write → ESMU sim register read-back
 *
 * Part A (план за утре): синтетски 96×15min профил (load+PV+2-тарифна цена),
 *   оптимизерот пресметува план → push преку VT enertrek-push.ts клиентот
 *   → PUT 200 {planId} + GET (current-or-next) го враќа планот.
 * Part B (live извршување): near-term step план (3.0 → 1.0 → 0 kW) на ESMU sim
 *   (port 5022, unit 1, reg 41000, scale 10) — за секој чекор се чека commands
 *   запис (result 'plan:volttrade-e2e%') + независен Modbus read-back.
 *
 * Прелоз: dev server :3000 (EMS_TICK_S=5), ESMU sim :5022, broker :1883.
 * Run: cd /mnt/agents/output/app && npx tsx scripts/probe-v9-e2e-integration.ts
 */
import "dotenv/config";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import ModbusRTU from "modbus-serial";
import { getDb } from "../api/queries/connection";
import { commands, meters } from "../db/schema";
// VoltTrade _shared (pure TS, Contract B) — cross-repo import
import { optimizePortfolio } from "../../../work/volttrade-erp/supabase/functions/_shared/optimize";
import { pushEmsPlan } from "../../../work/volttrade-erp/supabase/functions/_shared/enertrek-push";
import type { BatteryAsset, ForecastPoint, Setpoint } from "../../../work/volttrade-erp/supabase/functions/_shared/types";

const BASE = "http://localhost:3000";
const SOURCE = "volttrade-e2e";
const ESMU_PORT = 5022;
const ESMU_UNIT = 1;
const ESMU_REG = 41000;
const ESMU_SCALE = 10;

let pass = 0, fail = 0;
const fails: string[] = [];
function probe(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  PASS ${name}${detail !== undefined ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
  else { fail++; fails.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); }
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

const jars: Record<string, string> = {};
async function trpc(proc: string, payload: unknown, who?: string): Promise<any> {
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

async function readRegister(): Promise<number | null> {
  const client = new ModbusRTU();
  try {
    await client.connectTCP("127.0.0.1", { port: ESMU_PORT });
    client.setID(ESMU_UNIT);
    client.setTimeout(5000);
    const reg = await client.readHoldingRegisters(ESMU_REG, 1);
    return reg.data?.[0] ?? null;
  } catch {
    return null;
  } finally {
    await client.close(() => undefined);
  }
}

async function writeReg(value: number): Promise<void> {
  const client = new ModbusRTU();
  try {
    await client.connectTCP("127.0.0.1", { port: ESMU_PORT });
    client.setID(ESMU_UNIT);
    client.setTimeout(5000);
    await client.writeRegister(ESMU_REG, value);
  } finally {
    await client.close(() => undefined);
  }
}

async function main() {
  const db = getDb();
  console.log("=== probe-v9-e2e-integration (INT.1) ===\n");
  const startedAt = Date.now();

  // ── setup ────────────────────────────────────────────────────────────────
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");
  // audit wave 4: this probe pushes plans via REST PUT (Part A/B), so after
  // the NULL=read-only flip the key needs explicit write scopes.
  const key = (await trpc("apiKeys.create", { name: "probe-v9-e2e", role: "operator", scopes: ["read", "control", "ems:write"] }, "admin")) as { id: number; key: string };
  const raw = key.key;

  const allMeters = await db.select().from(meters);
  const esmu = allMeters.find((m) => m.model === "esmu-bams-stack" && m.port === ESMU_PORT);
  if (!esmu) throw new Error("ESMU sim meter not found (model=esmu-bams-stack port=5022)");
  const meterId = esmu.id;
  console.log(`ESMU meter: id=${meterId} uid=${esmu.uid}`);

  try {
    // ── Part A: оптимизер → push план за утре ─────────────────────────────
    console.log("\n-- Part A: optimizePortfolio → pushEmsPlan (утре, 96×15min) --");
    const tomorrow = new Date(); tomorrow.setUTCHours(0, 0, 0, 0); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const periods: string[] = Array.from({ length: 96 }, (_, i) => new Date(tomorrow.getTime() + i * 900_000).toISOString());
    const fp = (ts: string, v: number): ForecastPoint => ({ ts, p10: Math.max(0, v * 0.85), p50: v, p90: v * 1.15 });
    const loadP: ForecastPoint[] = periods.map((ts) => {
      const t = new Date(ts); const h = t.getUTCHours() + t.getUTCMinutes() / 60;
      return fp(ts, 3 + 4 * Math.exp(-((h - 19) ** 2) / 18) + 1.5 * Math.exp(-((h - 8) ** 2) / 8));
    });
    const pvP: ForecastPoint[] = periods.map((ts) => {
      const t = new Date(ts); const h = t.getUTCHours() + t.getUTCMinutes() / 60;
      return fp(ts, Math.max(0, 12 * Math.sin((Math.PI * (h - 6)) / 12)));
    });
    const priceEurMwh = periods.map((ts) => { const h = new Date(ts).getUTCHours(); return h >= 6 && h < 22 ? 80 : 30; });
    const battery: BatteryAsset = {
      deviceRef: "esmu-sim-1", meterId, capacityKwh: 100, maxChargeKw: 10, maxDischargeKw: 10,
      socNowPct: 60, socMinPct: 10, socMaxPct: 95, roundTripEta: 0.92,
    };
    const out = optimizePortfolio({ periods, loadP, pvP, priceEurMwh, batteries: [battery] });
    const plan = out.batteryPlans.find((p) => p.meterId === meterId);
    probe("A1 optimizer врати план за ESMU батеријата (96 setpoints)", !!plan && plan.setpoints.length === 96,
      `setpoints=${plan?.setpoints.length ?? 0} notes=${out.notes.join("|").slice(0, 120)}`);
    probe("A2 buyKwh = 96 периоди, сите >= 0", out.buyKwh.length === 96 && out.buyKwh.every((b) => b >= 0));
    // Економски инваријант за PV-вишок профил (извоз = 0€): батеријата се празни
    // во вечерната скапа тарифа; полнење смее само од PV вишок или во евтина
    // тарифа — НИКОГАШ од мрежа по висока цена без вишок. (Ноќното празнење за
    // простор за бесплатен PV е оптимално, не грешка.)
    const eveningDis = plan!.setpoints.filter((s) => { const h = new Date(s.ts).getUTCHours(); return h >= 17 && h <= 21; }).some((s) => s.kw > 0);
    const charges = plan!.setpoints.filter((s) => s.kw < 0);
    const gridChargeHighPrice = charges.filter((s) => {
      const i = periods.indexOf(s.ts);
      return priceEurMwh[i] > 30 && pvP[i].p50 <= loadP[i].p50;
    });
    const chargesFromSurplus = charges.some((s) => { const i = periods.indexOf(s.ts); return pvP[i].p50 > loadP[i].p50; });
    probe("A3 економика: празни навечер (скапо); полнење само од PV вишок/евтино",
      eveningDis && gridChargeHighPrice.length === 0 && chargesFromSurplus,
      `eveningDischarge=${eveningDis} chargePeriods=${charges.length} violations=${gridChargeHighPrice.length} fromSurplus=${chargesFromSurplus}`);

    const putA = await pushEmsPlan(BASE, raw, meterId,
      periods[0], new Date(tomorrow.getTime() + 96 * 900_000).toISOString(), plan!.setpoints, SOURCE);
    probe("A4 PUT преку VT enertrek-push клиент → planId", typeof putA.planId === "number" && putA.planId > 0,
      `planId=${String(putA.planId)} superseded=${putA.superseded}`);

    const planRowsA = (await db.execute(sql`
      SELECT id, status, JSON_LENGTH(setpoints) AS n FROM ems_plans
      WHERE meter_id=${meterId} AND source=${SOURCE} ORDER BY id DESC LIMIT 1`))[0] as unknown as Array<{ id: number; status: string; n: number }>;
    const rowA = planRowsA[0];
    probe("A5 планот е во ems_plans (active, 96 setpoints)", rowA?.status === "active" && Number(rowA?.n) === 96, rowA);

    const getA = await v1("GET", `/devices/${meterId}/ems-plan`, raw);
    probe("A6 GET current-or-next го враќа утрешниот план",
      getA.status === 200 && getA.body?.plan?.id === rowA?.id && getA.body?.plan?.source === SOURCE,
      { status: getA.status, getId: getA.body?.plan?.id, dbId: rowA?.id });

    // ── Part B: live извршување на ESMU sim ────────────────────────────────
    console.log("\n-- Part B: near-term план → контролер → Modbus read-back --");
    await db.execute(sql`DELETE FROM ems_plans WHERE meter_id=${meterId} AND source=${SOURCE}`); // утрешниот не смее да се меша
    await writeReg(0);
    const marker0 = Number(((await db.execute(sql`SELECT COALESCE(MAX(id),0) AS mx FROM commands`))[0] as unknown as Array<{ mx: number }>)[0].mx);

    const t0 = new Date(Date.now() + 20_000);
    const steps: Array<{ at: Date; kw: number }> = [
      { at: t0, kw: 3.0 },
      { at: new Date(t0.getTime() + 120_000), kw: 1.0 },
      { at: new Date(t0.getTime() + 240_000), kw: 0 },
    ];
    const setpointsB: Setpoint[] = steps.map((s) => ({ ts: s.at.toISOString(), kw: s.kw }));
    const putB = await pushEmsPlan(BASE, raw, meterId,
      new Date(t0.getTime() - 60_000).toISOString(), new Date(t0.getTime() + 360_000).toISOString(), setpointsB, SOURCE);
    probe("B1 PUT near-term план → planId", typeof putB.planId === "number" && putB.planId > 0, putB);

    const reg0 = await readRegister();
    probe("B2 пред првиот чекор регистарот е 0 (idle)", reg0 === 0, `reg=${String(reg0)}`);

    const autoCmds = async () =>
      db.select().from(commands)
        .where(and(eq(commands.meterId, meterId), isNull(commands.userId), sql`id > ${marker0}`))
        .orderBy(desc(commands.id))
        .limit(20);

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const waitMs = s.at.getTime() - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      const expectedRaw = Math.round(s.kw * ESMU_SCALE);
      const cmd = await waitFor(async () => {
        const rows = (await autoCmds()).filter((c) =>
          c.controlKey === "activePowerKw" && Math.abs((c.controlValue ?? 0) - s.kw) < 1e-9 &&
          (c.result ?? "").startsWith(`plan:${SOURCE}`));
        return rows[0] ?? null;
      }, 90_000);
      const regOk = await waitFor(async () => ((await readRegister()) === expectedRaw ? true : null), 60_000, 2000);
      probe(`B3.${i} чекор ${s.kw} kW: команда plan:${SOURCE} + регистар=${expectedRaw}`,
        !!cmd && cmd.status === "ok" && !!regOk,
        cmd ? { status: cmd.status, v: cmd.controlValue, result: cmd.result, reg: regOk ? expectedRaw : await readRegister() } : "no command");
    }

    // Планот истекува (validTo = t0+6min) → lazy expire + ослободување на idle
    const expOk = await waitFor(async () => {
      const rows = (await db.execute(sql`
        SELECT COUNT(*) AS c FROM ems_plans WHERE meter_id=${meterId} AND source=${SOURCE} AND status='expired'`))[0] as unknown as Array<{ c: number }>;
      return Number(rows[0]?.c ?? 0) >= 1 ? true : null;
    }, 150_000);
    probe("B4 по истек планот е lazy-expired", !!expOk);
    const regEnd = await waitFor(async () => ((await readRegister()) === 0 ? true : null), 60_000, 2000);
    probe("B5 по истек регистарот е 0 (нема fallback команда)", !!regEnd, `reg=${String(await readRegister())}`);
  } finally {
    // ── cleanup ────────────────────────────────────────────────────────────
    await db.execute(sql`DELETE FROM ems_plans WHERE meter_id=${meterId} AND source=${SOURCE}`).catch(() => undefined);
    await trpc("apiKeys.revoke", { id: key.id }, "admin").catch(() => undefined);
    await writeReg(0).catch(() => undefined);
    const left = (await db.execute(sql`SELECT COUNT(*) AS c FROM ems_plans WHERE meter_id=${meterId} AND source=${SOURCE}`).catch(() => [[{ c: -1 }]]))[0] as unknown as Array<{ c: number }>;
    console.log(`\n[cleanup] key revoked, plans deleted (left=${String(left[0]?.c)}), register=0`);
  }

  console.log(`\n=== RESULT: ${pass} PASS, ${fail} FAIL (duration ${Math.round((Date.now() - startedAt) / 1000)}s) ===`);
  if (fails.length) console.log("FAILURES:", fails.join("; "));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
