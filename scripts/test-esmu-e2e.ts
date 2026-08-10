// End-to-end verification for the ESMU (BAMS) protocol integration (verifier v3:
// E2, E3, E4). Runs fully in-process against its own simulator on its own port —
// does NOT touch the demo fleet (127.0.0.1:5021) or other test rows.
//
//   simulator (1 ESMU stack unit 1 + 2 ESBCM strings units 2,3)
//     → Modbus TCP poller → telemetry store → alarm engine
//
// Exercises the protocol-specific decode paths added for ESMU:
//   - offset registers (current −1600 A, temperature −40 °C)
//   - u32 energy counters
//   - FC3 holding registers (stringCount @500, heartbeat @530)
//   - per-unit addressStride (string N block = base + (N−1)×3000)
//
// Run: npx tsx scripts/test-esmu-e2e.ts
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { meters, gateways, alarmRules, alarms, orgs, telemetry, telemetryHourly } from "../db/schema";
import { getTelemetryStore } from "../api/telemetry";
import { startPollerService, getPollerStatus } from "../api/poller/service";
import { invalidateRulesCache } from "../api/mqtt/handlers";
import { startSimulator, type SimProfile } from "./device-simulator";
import { DEVICE_PROFILE_LIBRARY } from "../db/device-profile-library";

const PORT = 5023;
const TEST_HOST = "127.0.0.1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${check} — ${detail}`);
};

async function main() {
  const db = getDb();

  console.log("1. starting ESMU simulator on port", PORT, "(unit 1=stack, units 2/3=strings)");
  const profiles: SimProfile[] = DEVICE_PROFILE_LIBRARY.filter((p) => p.model.startsWith("esmu-")).map((p) => ({
    model: p.model,
    deviceType: "bess" as const,
    registerMap: p.registerMap,
  }));
  if (profiles.length !== 2) throw new Error("esmu profiles missing from library");
  const sim = await startSimulator({
    port: PORT,
    profiles,
    devices: [
      { unitId: 1, model: "esmu-bams-stack", capacityKw: 250, soc: 60 },
      { unitId: 2, model: "esmu-bams-string", capacityKw: 125, soc: 58 },
      { unitId: 3, model: "esmu-bams-string", capacityKw: 125, soc: 62 },
    ],
    tickMs: 3000,
  });

  console.log("2. provisioning ESMU-T test devices (scoped to this port)");
  const directGw = await db.select().from(gateways).where(eq(gateways.uid, "direct-tcp")).limit(1);
  let gwId = directGw[0]?.id;
  if (!gwId) {
    const ins = await db
      .insert(gateways)
      .values({ uid: "direct-tcp", name: "Direct Modbus TCP (poller)", model: "TCP", transport: "tcp", topicPrefix: "-", status: "online" })
      .$returningId();
    gwId = ins[0].id;
  }
  // Clean previous ESMU-T rows only (name-scoped; demo fleet untouched)
  const old = await db.select({ id: meters.id }).from(meters).where(like(meters.name, "ESMU-T %"));
  if (old.length) {
    const oldIds = old.map((d) => d.id);
    await db.delete(telemetry).where(inArray(telemetry.meterId, oldIds)).catch(() => undefined);
    await db.delete(telemetryHourly).where(inArray(telemetryHourly.meterId, oldIds)).catch(() => undefined);
    await db.delete(alarms).where(inArray(alarms.meterId, oldIds)).catch(() => undefined);
    await db.delete(meters).where(inArray(meters.id, oldIds));
  }
  await db.delete(alarmRules).where(like(alarmRules.name, "ESMU-T %")).catch(() => undefined);
  const defaultOrg = await db.select().from(orgs).where(eq(orgs.name, "Default Org")).limit(1);
  const orgId = defaultOrg[0]?.id ?? 1;

  const maxRow = await db
    .select({ modbusAddress: meters.modbusAddress })
    .from(meters)
    .where(eq(meters.gatewayId, gwId))
    .orderBy(desc(meters.modbusAddress))
    .limit(1);
  let slot = (maxRow[0]?.modbusAddress ?? 500) + 1;

  for (const dev of sim.devices) {
    const isStack = dev.profile.model === "esmu-bams-stack";
    await db.insert(meters).values({
      gatewayId: gwId,
      orgId,
      name: `ESMU-T ${isStack ? "stack" : `string-${dev.unitId - 1}`} (unit ${dev.unitId})`,
      model: dev.profile.model,
      deviceType: "bess",
      brand: "ESMU",
      phases: "three",
      modbusAddress: slot++,
      host: TEST_HOST,
      port: PORT,
      unitId: dev.unitId,
      pollIntervalSec: 5,
      status: "offline",
    });
  }
  const devRows = await db.select().from(meters).where(like(meters.name, "ESMU-T %"));
  const stackRow = devRows.find((r) => r.model === "esmu-bams-stack")!;
  const stringRows = devRows.filter((r) => r.model === "esmu-bams-string");

  console.log("3. starting poller, waiting for poll cycles");
  startPollerService();
  await sleep(25_000); // stagger + first polls + a couple of 5s cycles

  const store = getTelemetryStore();

  // ── E2: stack telemetry decoded, offsets/u32/FC3 applied ──────────────────
  const stack = await store.latest(stackRow.id);
  const sv = stack?.values ?? {};
  const stackIssues: string[] = [];
  const need = (k: string) => sv[k] === undefined && stackIssues.push(`missing ${k}`);
  ["socPercent", "sohPercent", "batteryVoltageV", "batteryCurrentA", "bmsStatusCode", "stringCount", "heartbeatCounter",
    "chargeEnergyTotalKwh", "dischargeEnergyTotalKwh", "cellTempMaxC", "cellVoltageMaxV", "insulationResistanceKohm",
    "breakerStatus", "pcsCommFault"].forEach(need);
  if (sv.socPercent !== undefined && (sv.socPercent < 5 || sv.socPercent > 100)) stackIssues.push(`soc=${sv.socPercent}`);
  // HV stack ~722–810 V
  if (sv.batteryVoltageV !== undefined && (sv.batteryVoltageV < 600 || sv.batteryVoltageV > 900))
    stackIssues.push(`stackV=${sv.batteryVoltageV}`);
  // offset decode: idle current must be ~0 A, NOT 1600 A (un-offset raw)
  if (sv.batteryCurrentA !== undefined && Math.abs(sv.batteryCurrentA) > 400) stackIssues.push(`stackI=${sv.batteryCurrentA}`);
  // offset decode: temps must be physical, NOT raw+40
  if (sv.cellTempMaxC !== undefined && (sv.cellTempMaxC < 0 || sv.cellTempMaxC > 45))
    stackIssues.push(`cellTempMax=${sv.cellTempMaxC}`);
  if (sv.cellVoltageMaxV !== undefined && (sv.cellVoltageMaxV < 3 || sv.cellVoltageMaxV > 3.6))
    stackIssues.push(`cellVMax=${sv.cellVoltageMaxV}`);
  if (sv.stringCount !== undefined && sv.stringCount !== 2) stackIssues.push(`stringCount=${sv.stringCount} (FC3 read)`);
  if (sv.chargeEnergyTotalKwh !== undefined && sv.chargeEnergyTotalKwh <= 0) stackIssues.push("chargeEnergyTotal<=0 (u32)");
  if (sv.bmsStatusCode !== undefined && ![1, 2, 3, 8].includes(sv.bmsStatusCode)) stackIssues.push(`state=${sv.bmsStatusCode}`);
  record(
    "E2 ESMU stack telemetry decoded (offset/u32/FC3)",
    stackIssues.length === 0 && Object.keys(sv).length >= 20,
    stackIssues.length
      ? stackIssues.join("; ")
      : `${Object.keys(sv).length} keys; V=${sv.batteryVoltageV} I=${sv.batteryCurrentA} SOC=${sv.socPercent} state=${sv.bmsStatusCode} strings=${sv.stringCount} hb=${sv.heartbeatCounter}`,
  );

  // ── E3: per-unit addressStride — strings serve distinct blocks ────────────
  const s1 = stringRows.find((r) => r.unitId === 2)!;
  const s2 = stringRows.find((r) => r.unitId === 3)!;
  const v1 = (await store.latest(s1.id))?.values ?? {};
  const v2 = (await store.latest(s2.id))?.values ?? {};
  const strideIssues: string[] = [];
  for (const [name, vv] of [["string-1", v1], ["string-2", v2]] as const) {
    if (Object.keys(vv).length < 20) strideIssues.push(`${name}: only ${Object.keys(vv).length} keys`);
    // SOC sim floor is 5; a wrong (unshifted) read lands on empty registers → 0
    if (vv.socPercent === undefined || vv.socPercent < 5) strideIssues.push(`${name}: soc=${vv.socPercent}`);
    if (vv.batteryVoltageV !== undefined && (vv.batteryVoltageV < 600 || vv.batteryVoltageV > 900))
      strideIssues.push(`${name}: V=${vv.batteryVoltageV}`);
  }
  // strings were started at SOC 58 vs 62 — identical blocks would give identical SOC
  if (v1.socPercent !== undefined && v2.socPercent !== undefined && v1.socPercent === v2.socPercent)
    strideIssues.push(`identical SOC ${v1.socPercent} on both strings (blocks not shifted?)`);
  record(
    "E3 addressStride per-unit blocks (string 1 @100, string 2 @3100)",
    strideIssues.length === 0,
    strideIssues.length
      ? strideIssues.join("; ")
      : `string-1 SOC=${v1.socPercent} V=${v1.batteryVoltageV}; string-2 SOC=${v2.socPercent} V=${v2.batteryVoltageV}`,
  );

  // ── E4: alarms on ESMU native state + SOC, with auto-resolve ──────────────
  console.log("4. alarm rule tests");
  const [faultRule] = await db
    .insert(alarmRules)
    .values({ name: "ESMU-T BMS fault state", metric: "bmsStatusCode", operator: "gt", threshold: 7, severity: "critical", meterId: stackRow.id, orgId })
    .$returningId();
  const [socRule] = await db
    .insert(alarmRules)
    .values({ name: "ESMU-T string low SOC", metric: "socPercent", operator: "lt", threshold: 30, severity: "warning", meterId: s1.id, orgId })
    .$returningId();
  invalidateRulesCache();

  sim.setFault(1, 1); // stack → bmsStatusCode 8 (fault), breaker opens
  sim.setSoc(2, 20); // string 1 → SOC 20
  await sleep(14_000);

  const active = await db
    .select()
    .from(alarms)
    .where(and(inArray(alarms.ruleId, [faultRule.id, socRule.id]), eq(alarms.status, "active")));
  const faultAlarm = active.find((a) => a.ruleId === faultRule.id);
  const socAlarm = active.find((a) => a.ruleId === socRule.id);
  record("E4 bmsStatusCode=8 fault alarm fired", !!faultAlarm, faultAlarm ? faultAlarm.message : "no active alarm");
  record("E4 string low-SOC alarm fired", !!socAlarm, socAlarm ? socAlarm.message : "no active alarm");

  sim.setFault(1, 0);
  sim.setSoc(2, 80);
  await sleep(14_000);
  const stillActive = await db
    .select()
    .from(alarms)
    .where(and(inArray(alarms.ruleId, [faultRule.id, socRule.id]), eq(alarms.status, "active")));
  record("E4 alarms auto-resolved", stillActive.length === 0, `${stillActive.length} still active`);

  const pollerStatus = getPollerStatus();
  const esmuPoller = pollerStatus.devices.filter((d) => d.name.startsWith("ESMU-T"));
  console.log("poller:", JSON.stringify(esmuPoller.map((d) => ({ name: d.name, polls: d.polls, failures: d.failures, err: d.lastError }))));
  const noFailures = esmuPoller.every((d) => d.failures === 0);
  record(
    "E2 poller stable (0 failures on all ESMU objects)",
    noFailures && esmuPoller.length === 3,
    esmuPoller.map((d) => `${d.name.split(" (")[0]}: ${d.polls} polls/${d.failures} fail`).join(", "),
  );

  // Persist run record
  mkdirSync("verifier/runs", { recursive: true });
  const passed = results.filter((r) => r.pass).length;
  const ok = passed === results.length;
  writeFileSync(
    `verifier/runs/${new Date().toISOString().replace(/[:.]/g, "-")}-esmu-e2e.json`,
    JSON.stringify(
      {
        command: "npx tsx scripts/test-esmu-e2e.ts",
        criteria: ["E2", "E3", "E4"],
        results,
        poller: esmuPoller,
        summary: `${passed}/${results.length} checks passed`,
      },
      null,
      2,
    ),
  );

  console.log(ok ? `\nALL ${results.length} CHECKS PASSED` : `\n${results.length - passed} CHECK(S) FAILED`);
  await sim.stop();
  await store.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(2);
});
