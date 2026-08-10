// End-to-end verification for the PV/BESS integration (verifier v1: C5, C6, C7).
//
//   simulator (Modbus TCP, in-process) → poller → telemetry store → alarm engine
//
// Covers: vendor maps (SMA native big addresses, SolarEdge SunSpec floats with
// wordSwap, Victron GX battery/system service), community maps (Huawei, BYD,
// Pylontech), alarm firing and auto-resolve on BOTH a fault code and SOC, and
// fleet latestAll latency.
//
// Run: npx tsx scripts/test-pv-e2e.ts
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { meters, gateways, alarmRules, alarms } from "../db/schema";
import { getTelemetryStore } from "../api/telemetry";
import { startPollerService, getPollerStatus } from "../api/poller/service";
import { invalidateRulesCache } from "../api/mqtt/handlers";
import { startSimulator, type SimProfile } from "./device-simulator";
import { DEVICE_PROFILE_LIBRARY } from "../db/device-profile-library";

const PORT = 5021;
const TEST_HOST = "127.0.0.1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${check} — ${detail}`);
};

// Pick profiles that exercise all decode paths: big native addresses (SMA),
// wordSwap float (SolarEdge), community int maps (Huawei, Victron), BESS.
const PICKS = ["sma-sunspec", "solaredge-sunspec", "huawei-sun2000", "victron-gx", "byd-battery-box", "pylontech-bess"];

async function main() {
  const db = getDb();

  console.log("1. starting PV/BESS simulator on port", PORT);
  const profiles: SimProfile[] = PICKS.map((m) => {
    const p = DEVICE_PROFILE_LIBRARY.find((x) => x.model === m);
    if (!p) throw new Error(`profile ${m} missing from library`);
    return { model: p.model, deviceType: p.deviceType as "inverter" | "bess", registerMap: p.registerMap };
  });
  const sim = await startSimulator({
    port: PORT,
    profiles,
    counts: { inverter: 4, bess: 2 },
    tickMs: 3000,
  });

  console.log("2. provisioning test devices");
  const directGw = await db.select().from(gateways).where(eq(gateways.uid, "direct-tcp")).limit(1);
  let gwId = directGw[0]?.id;
  if (!gwId) {
    const ins = await db
      .insert(gateways)
      .values({ uid: "direct-tcp", name: "Direct Modbus TCP (poller)", model: "TCP", transport: "tcp", topicPrefix: "-", status: "online" })
      .$returningId();
    gwId = ins[0].id;
  }
  // Clean previous test devices
  await db.delete(meters).where(and(eq(meters.gatewayId, gwId), eq(meters.host, TEST_HOST)));

  const profileMeta = new Map(DEVICE_PROFILE_LIBRARY.map((p) => [p.model, p]));
  const slotBase = 500;
  for (const dev of sim.devices) {
    const meta = profileMeta.get(dev.profile.model)!;
    await db.insert(meters).values({
      gatewayId: gwId,
      name: `${meta.brand} ${meta.deviceType === "inverter" ? "INV" : "BESS"}-${dev.unitId}`,
      model: dev.profile.model,
      deviceType: meta.deviceType,
      brand: meta.brand,
      phases: "three",
      modbusAddress: slotBase + dev.unitId,
      host: TEST_HOST,
      port: PORT,
      unitId: dev.unitId,
      pollIntervalSec: 5,
      status: "offline",
    });
  }
  const devRows = await db.select().from(meters).where(and(eq(meters.gatewayId, gwId), eq(meters.host, TEST_HOST)));
  const byUnit = new Map(devRows.map((r) => [r.unitId!, r]));

  console.log("3. starting poller, waiting for poll cycles");
  startPollerService();
  await sleep(25_000); // stagger (≤5s) + first polls + a couple of 5s cycles

  const store = getTelemetryStore();
  const inverterRows = devRows.filter((r) => r.deviceType === "inverter");
  const bessRows = devRows.filter((r) => r.deviceType === "bess");

  // ── C5: telemetry lands with expected keys & sane values ──────────────────
  // Profiles expose different key sets (e.g. Victron GX is battery/system
  // service — no AC power key), so range checks apply only to keys the
  // profile's own register map declares; every device must decode ≥3 keys.
  let withData = 0;
  const keyIssues: string[] = [];
  for (const row of devRows) {
    const latest = await store.latest(row.id);
    if (!latest || Object.keys(latest.values).length === 0) {
      keyIssues.push(`${row.name}: no values`);
      continue;
    }
    withData++;
    const v = latest.values;
    const mapKeys = new Set((profileMeta.get(row.model)?.registerMap ?? []).map((r) => r.key));
    const decoded = Object.keys(v).length;
    if (decoded < 3) keyIssues.push(`${row.name}: only ${decoded} keys decoded`);
    if (mapKeys.has("activePowerKw") && (v.activePowerKw === undefined || v.activePowerKw < 0 || v.activePowerKw > 1000))
      keyIssues.push(`${row.name}: activePowerKw=${v.activePowerKw}`);
    if (mapKeys.has("frequencyHz") && v.frequencyHz !== undefined && (v.frequencyHz < 45 || v.frequencyHz > 55))
      keyIssues.push(`${row.name}: frequencyHz=${v.frequencyHz}`);
    if (mapKeys.has("socPercent") && (v.socPercent === undefined || v.socPercent < 0 || v.socPercent > 100))
      keyIssues.push(`${row.name}: socPercent=${v.socPercent}`);
    if (mapKeys.has("batteryVoltageV") && v.batteryVoltageV !== undefined && (v.batteryVoltageV < 10 || v.batteryVoltageV > 1000))
      keyIssues.push(`${row.name}: batteryVoltageV=${v.batteryVoltageV}`);
  }
  record(
    "C5 all simulated devices reporting",
    withData === devRows.length,
    `${withData}/${devRows.length} devices have telemetry (4 inverters + 2 BESS)`,
  );
  record("C5 decoded values sane", keyIssues.length === 0, keyIssues.length ? keyIssues.join("; ") : "all values in physical range");

  // wordSwap spot check: SolarEdge row must decode float CDAB correctly
  const se = devRows.find((r) => r.model === "solaredge-sunspec");
  if (se) {
    const latest = await store.latest(se.id);
    const hz = latest?.values.frequencyHz;
    record(
      "C5 wordSwap decode (SolarEdge float CDAB)",
      hz !== undefined && hz > 45 && hz < 55,
      `SolarEdge frequencyHz=${hz} (expect ~50)`,
    );
  }

  // ── C6: alarms on new device metrics ──────────────────────────────────────
  console.log("4. alarm rule tests");
  const invTarget = inverterRows[0];
  const bessTarget = bessRows[0];
  const [faultRule] = await db
    .insert(alarmRules)
    .values({ name: "E2E inverter fault", metric: "faultCode", operator: "gt", threshold: 0, severity: "critical", meterId: invTarget.id })
    .$returningId();
  const [socRule] = await db
    .insert(alarmRules)
    .values({ name: "E2E low SOC", metric: "socPercent", operator: "lt", threshold: 30, severity: "warning", meterId: bessTarget.id })
    .$returningId();
  invalidateRulesCache();

  sim.setFault(invTarget.unitId!, 32);
  sim.setSoc(bessTarget.unitId!, 20);
  await sleep(14_000); // 2+ poll cycles

  const activeAlarms = await db
    .select()
    .from(alarms)
    .where(and(inArray(alarms.ruleId, [faultRule.id, socRule.id]), eq(alarms.status, "active")));
  const faultAlarm = activeAlarms.find((a) => a.ruleId === faultRule.id);
  const socAlarm = activeAlarms.find((a) => a.ruleId === socRule.id);
  record("C6 faultCode alarm fired", !!faultAlarm, faultAlarm ? faultAlarm.message : "no active alarm");
  record("C6 low-SOC alarm fired", !!socAlarm, socAlarm ? socAlarm.message : "no active alarm");

  sim.setFault(invTarget.unitId!, 0);
  sim.setSoc(bessTarget.unitId!, 80);
  await sleep(14_000);
  const stillActive = await db
    .select()
    .from(alarms)
    .where(and(inArray(alarms.ruleId, [faultRule.id, socRule.id]), eq(alarms.status, "active")));
  record("C6 alarms auto-resolved", stillActive.length === 0, `${stillActive.length} still active`);

  // ── C7: fleet query latency ────────────────────────────────────────────────
  const t0 = performance.now();
  const all = await store.latestAll();
  const ms = Math.round(performance.now() - t0);
  record("C7 latestAll latency", ms < 2000, `${ms} ms over ${all.size} devices`);

  const pollerStatus = getPollerStatus();
  console.log("poller:", JSON.stringify(pollerStatus.devices.map((d) => ({ name: d.name, polls: d.polls, failures: d.failures, err: d.lastError }))));

  // Persist run record
  mkdirSync("verifier/runs", { recursive: true });
  const passed = results.filter((r) => r.pass).length;
  const ok = passed === results.length;
  writeFileSync(
    `verifier/runs/${new Date().toISOString().replace(/[:.]/g, "-")}-e2e.json`,
    JSON.stringify(
      {
        command: "npx tsx scripts/test-pv-e2e.ts",
        criteria: ["C5", "C6", "C7"],
        results,
        poller: pollerStatus.devices,
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
