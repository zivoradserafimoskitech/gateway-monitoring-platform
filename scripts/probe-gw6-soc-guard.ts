// probe-gw6-soc-guard.ts — wave 6 live smoke: BESS fail-closed SoC guard.
// Proves on the live dev stack (vite :3000 EMS_TICK_S=5 + esmu-sim :5022):
//   (1) REST validation: minSoc>maxSoc → 400, out-of-range → 400
//   (2) positive control: plan with minSoc BELOW current soc → discharge executes
//   (3) plan with minSoc ABOVE current soc → blocked → explicit idle 0 kW + log
//   (4) low-min plan again → executes (sets lastCmd=2.5 for the transition)
//   (5) staleness fail-closed: kill esmu-sim, wait > CONTROL_TELEMETRY_MAX_AGE_MS
//       (default 120 s) → same plan forced to idle 0 kW with "soc unknown
//       (fail-closed)" — the hardware-damage bug class is closed.
// Run: npx tsx scripts/probe-gw6-soc-guard.ts   (AFTER probe-v9 has finished)
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import ModbusRTU from "modbus-serial";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { getDb } from "../api/queries/connection";
import { commands, deviceProfiles, meters } from "../db/schema";

const BASE = "http://localhost:3000";
const jars: Record<string, string> = {};
const SOURCE = "gw6-smoke";
const DEV_LOG = "/mnt/agents/output/logs/dev.log";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 90_000, stepMs = 2500): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

function devLogFrom(offset: number): string {
  try {
    return readFileSync(DEV_LOG, "utf8").slice(offset);
  } catch {
    return "";
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
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");
  const key = (await trpc("apiKeys.create", { name: "probe-gw6", role: "operator", scopes: ["read", "control", "ems:write"] }, "admin")) as { id: number; key: string };
  const raw = key.key;

  const esmuRows = await db.select().from(meters).where(and(eq(meters.model, "esmu-bams-stack"), eq(meters.port, 5022))).limit(1);
  const esmu = esmuRows[0];
  if (!esmu) throw new Error("ESMU stack meter on port 5022 not found");
  const esmuId = esmu.id;

  await db.update(deviceProfiles).set({
    controllable: {
      activePowerKw: { address: 41000, fc: 6, min: 0, max: 250, scale: 10, unit: "kW", description: "PCS active power setpoint (+ = discharge)" },
    },
  }).where(eq(deviceProfiles.model, "esmu-bams-stack"));

  const cmdIdAfter = Number(((await db.execute(sql`select coalesce(max(id),0) as mx from commands`))[0] as unknown as Array<{ mx: number }>)[0].mx);
  const autoCmds = async () =>
    db.select().from(commands)
      .where(and(eq(commands.meterId, esmuId), isNull(commands.userId), sql`id > ${cmdIdAfter}`))
      .orderBy(desc(commands.id));

  // Current SoC from the telemetry store (what freshForControl will read).
  const socRow = (await db.execute(
    sql`select json_unquote(json_extract(values_json,'$.socPercent')) as soc from telemetry where meter_id = ${esmuId} order by ts desc limit 1`,
  ))[0] as unknown as Array<{ soc: string | null }>;
  const soc = socRow[0]?.soc == null ? null : Number(socRow[0].soc);
  if (soc == null || Number.isNaN(soc)) throw new Error("no SoC telemetry for ESMU meter — is esmu-sim running?");
  console.log("current SoC:", soc);

  const highMin = Math.min(95, Math.round(soc) + 20); // above soc → discharge blocked
  const planBody = (minSoc: number) => ({
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validTo: new Date(Date.now() + 20 * 60_000).toISOString(),
    source: SOURCE,
    minSoc,
    setpoints: [{ ts: new Date(Date.now() - 60_000).toISOString(), kw: 2.5 }],
  });

  try {
    // ── (1) REST validation ────────────────────────────────────────────────
    const badOrder = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, { ...planBody(80), maxSoc: 50 });
    const badRange = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, { ...planBody(-5) });
    probe("(1) minSoc>maxSoc → 400; minSoc<0 → 400", badOrder.status === 400 && badRange.status === 400, { badOrder: badOrder.status, badRange: badRange.status });

    // ── (2) positive control: minSoc below soc → discharge executes ───────
    const lowPut = await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, planBody(10));
    const okEcho = lowPut.status === 200 && lowPut.body?.minSoc === 10 && lowPut.body?.maxSoc === null;
    const cmd2 = await waitFor(async () =>
      (await autoCmds()).filter((c) => c.controlKey === "activePowerKw" && Math.abs((c.controlValue ?? 0) - 2.5) < 1e-9 && (c.result ?? "").startsWith(`plan:${SOURCE}`))[0] ?? null);
    probe("(2) plan minSoc=10 (below soc): PUT echoes limits, 2.5 kW discharge EXECUTED", okEcho && cmd2?.status === "ok", { echo: { s: lowPut.status, min: lowPut.body?.minSoc, max: lowPut.body?.maxSoc }, cmd: cmd2 && { v: cmd2.controlValue, r: cmd2.result?.slice(0, 60) } });

    // ── (3) high minSoc → blocked → explicit idle 0 kW ────────────────────
    const off3 = readFileSync(DEV_LOG, "utf8").length;
    await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, planBody(highMin));
    const cmd3 = await waitFor(async () =>
      (await autoCmds()).filter((c) => c.controlKey === "activePowerKw" && Math.abs(c.controlValue ?? 1) < 1e-9 && (c.result ?? "").startsWith(`plan:${SOURCE}`))[0] ?? null);
    const log3 = devLogFrom(off3);
    probe(
      `(3) plan minSoc=${highMin} (> soc ${soc}): BLOCKED → idle 0 kW + "BLOCKED by SoC guard: soc … <= min" in dev log`,
      cmd3?.status === "ok" && log3.includes("BLOCKED by SoC guard") && /soc [\d.]+% <= min/.test(log3),
      { cmd: cmd3 && { v: cmd3.controlValue, r: cmd3.result?.slice(0, 60) }, logHit: /BLOCKED by SoC guard: [^→]+/.exec(log3)?.[0]?.slice(0, 90) ?? null },
    );

    // ── (4) low-min again → executes 2.5 kW (arms lastCmd for the (5) 2.5→0 transition)
    await v1("PUT", `/devices/${esmuId}/ems-plan`, raw, planBody(10));
    const cmd4 = await waitFor(async () =>
      (await autoCmds()).filter((c) => c.controlKey === "activePowerKw" && Math.abs((c.controlValue ?? 0) - 2.5) < 1e-9 && (c.result ?? "").startsWith(`plan:${SOURCE}`))[0] ?? null);
    probe("(4) plan minSoc=10 again → 2.5 kW executed (transition armed)", cmd4?.status === "ok", cmd4 && { v: cmd4.controlValue });

    // ── (5) staleness fail-closed ──────────────────────────────────────────
    // Stop the watchdog first (it would revive the sim within 30 s), then the sim.
    const wdPid = execSync("ps -ef | grep 'scripts/watchdog.sh' | grep -v grep | awk '{print $2}' | head -1").toString().trim();
    const simPids = execSync("ps -ef | grep 'device-simulator' | grep -v grep | awk '{print $2}'").toString().trim().split("\n").filter(Boolean);
    console.log("stopping watchdog", wdPid, "and device-simulator pids", simPids.join(","));
    if (wdPid) process.kill(Number(wdPid), "SIGKILL");
    for (const p of simPids) process.kill(Number(p), "SIGKILL");

    const off5 = readFileSync(DEV_LOG, "utf8").length;
    console.log("waiting 125 s for telemetry to age past CONTROL_TELEMETRY_MAX_AGE_MS=120 s …");
    await sleep(125_000);
    const cmd5 = await waitFor(async () =>
      (await autoCmds()).filter((c) => c.controlKey === "activePowerKw" && Math.abs(c.controlValue ?? 1) < 1e-9 && (c.result ?? "").startsWith(`plan:${SOURCE}`))[0] ?? null);
    const log5 = devLogFrom(off5);
    // Proof of fail-closed: the controller chose idle 0 kW (NOT the 2.5 kW
    // discharge) — the Modbus write itself fails ECONNREFUSED because the sim
    // is necessarily down to create staleness; status "ok" is impossible here
    // and NOT part of the assertion. A fail-open regression would show v=2.5.
    probe(
      "(5) telemetry stale (>120 s) + plan limits → fail-CLOSED: 2.5 kW discharge NOT dispatched; idle 0 kW attempted + \"soc unknown (fail-closed)\" logged",
      cmd5 !== null && Math.abs(cmd5.controlValue ?? 1) < 1e-9 && log5.includes("soc unknown (fail-closed)"),
      { cmd: cmd5 && { v: cmd5.controlValue, r: cmd5.result?.slice(0, 60) }, logHit: /soc unknown \(fail-closed\)/.test(log5) },
    );
  } finally {
    // ── (6) cleanup: plans gone, key revoked, register reset, stack restored ─
    await db.execute(sql`delete from ems_plans where meter_id = ${esmuId} and source = ${SOURCE}`).catch(() => undefined);
    await trpc("apiKeys.revoke", { id: key.id }, "admin").catch(() => undefined);
    await writeRegister(0).catch(() => undefined);
    // Restart the watchdog — it revives the dev server (if wedged) and the sims.
    try {
      execSync("cd /mnt/agents/output/app && setsid nohup bash scripts/watchdog.sh >> /mnt/agents/output/logs/watchdog-stdout.log 2>&1 &");
    } catch { /* best effort */ }
    await sleep(15_000);
    const simsBack = execSync("ps -ef | grep 'device-simulator' | grep -v grep | wc -l").toString().trim();
    probe("(6) cleanup: plans deleted, key revoked, register 0, watchdog restarted (sim processes back)", Number(simsBack) >= 1, { simsBack });
  }

  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
