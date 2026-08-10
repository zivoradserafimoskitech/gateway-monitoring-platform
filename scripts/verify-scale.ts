// Scale verification (verifier v2: S1-S5) — run while the load is active:
//   500 MQTT gateways (simulator --scale) + 30 PV plants / 20 BESS (poller).
// Writes verifier/runs/<ts>-scale.json. Run: npx tsx scripts/verify-scale.ts
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { and, count, eq, gt, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { meters, gateways, alarmRules, alarms } from "../db/schema";
import { getTelemetryStore } from "../api/telemetry";

const FRESH_SEC = 120; // liveness is coalesced to ~60 s/device by design + flush slack
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${check} — ${detail}`);
};

async function main() {
  const db = getDb();
  const store = getTelemetryStore();
  const freshSince = new Date(Date.now() - FRESH_SEC * 1000);

  // ── S3: fleet latestAll latency at full scale (3 samples) ────────────────
  const lat: number[] = [];
  let fleetSize = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const all = await store.latestAll();
    lat.push(Math.round(performance.now() - t0));
    fleetSize = all.size;
    await new Promise((r) => setTimeout(r, 800));
  }
  const latMax = Math.max(...lat);
  record("S3 latestAll latency at scale", latMax < 3000, `${lat.join("/")} ms over ${fleetSize} devices (limit 3000 ms)`);

  // ── S1: MQTT path — scale gateways with fresh liveness ───────────────────
  const scaleGw = await db
    .select({ id: gateways.id, lastSeenAt: gateways.lastSeenAt })
    .from(gateways)
    .where(or(like(gateways.uid, "170%"), like(gateways.uid, "860%")));
  const freshGw = scaleGw.filter((g) => g.lastSeenAt && g.lastSeenAt > freshSince).length;
  record(
    "S1 scale gateways reporting (MQTT)",
    scaleGw.length >= 500 && freshGw / scaleGw.length >= 0.95,
    `${freshGw}/${scaleGw.length} gateways fresh (<${FRESH_SEC}s)`,
  );

  // scale meters fresh (via meters.last_seen_at)
  const gwIds = scaleGw.map((g) => g.id);
  let meterTotal = 0;
  let meterFresh = 0;
  for (let i = 0; i < gwIds.length; i += 500) {
    const chunk = gwIds.slice(i, i + 500);
    meterTotal += (await db.select({ c: count() }).from(meters).where(inArray(meters.gatewayId, chunk)))[0].c;
    meterFresh += (
      await db.select({ c: count() }).from(meters).where(and(inArray(meters.gatewayId, chunk), gt(meters.lastSeenAt, freshSince)))
    )[0].c;
  }
  record(
    "S1 scale meters fresh (MQTT)",
    meterTotal > 0 && meterFresh / meterTotal >= 0.95,
    `${meterFresh}/${meterTotal} meters fresh`,
  );

  // ── S2: TCP path — SCL devices fresh + poller failure rate ───────────────
  const sclRows = await db.select().from(meters).where(like(meters.name, "SCL %"));
  const sclFresh = sclRows.filter((m) => m.lastSeenAt && m.lastSeenAt > freshSince).length;
  record(
    "S2 scale PV/BESS devices reporting (TCP)",
    sclRows.length === 110 && sclFresh === sclRows.length,
    `${sclFresh}/${sclRows.length} devices fresh (90 inverters + 20 BESS on 30 plants)`,
  );

  let polls = 0;
  let failures = 0;
  let pollerDevs = 0;
  try {
    const res = await fetch("http://127.0.0.1:3000/api/trpc/poller.status");
    const json = (await res.json()) as any;
    const devs = json.result.data.json.devices as Array<{ name: string; polls: number; failures: number }>;
    const scl = devs.filter((d) => d.name.startsWith("SCL "));
    pollerDevs = scl.length;
    polls = scl.reduce((s, d) => s + d.polls, 0);
    failures = scl.reduce((s, d) => s + d.failures, 0);
  } catch (e) {
    record("S2 poller status endpoint", false, String(e));
  }
  const failRate = polls > 0 ? failures / polls : 1;
  record(
    "S2 poller failure rate",
    pollerDevs === 110 && polls > 0 && failRate < 0.01,
    `${pollerDevs} devices, ${polls} polls, ${failures} failures (${(failRate * 100).toFixed(2)}%)`,
  );

  // ── S4: app health — RSS, MQTT connectivity ──────────────────────────────
  const rssKb = Number(execSync(`ps -o rss= -p $(lsof -tiTCP:3000 -sTCP:LISTEN)`).toString().trim());
  const rssMb = Math.round(rssKb / 1024);
  record("S4 app process healthy", rssMb > 0 && rssMb < 4096, `app RSS ${rssMb} MB (baseline 454 MB at load start)`);

  // ── S5: alarm engine at scale ────────────────────────────────────────────
  const sclRules = await db.select({ id: alarmRules.id }).from(alarmRules).where(like(alarmRules.name, "SCL %"));
  const ruleIds = sclRules.map((r) => r.id);
  const sclMeterIds = new Set(sclRows.map((m) => m.id));
  let activeCnt = 0;
  let misattributed = 0;
  if (ruleIds.length) {
    const act = await db
      .select({ meterId: alarms.meterId })
      .from(alarms)
      .where(and(inArray(alarms.ruleId, ruleIds), eq(alarms.status, "active")));
    activeCnt = act.length;
    misattributed = act.filter((a) => a.meterId !== null && !sclMeterIds.has(a.meterId)).length;
  }
  record(
    "S5 SOC alarms fired at scale",
    ruleIds.length === 20 && activeCnt > 0 && misattributed === 0,
    `${activeCnt}/${ruleIds.length} scale SOC rules active, ${misattributed} misattributed`,
  );

  // ── persist run record ───────────────────────────────────────────────────
  mkdirSync("verifier/runs", { recursive: true });
  const passed = results.filter((r) => r.pass).length;
  const ok = passed === results.length;
  writeFileSync(
    `verifier/runs/${new Date().toISOString().replace(/[:.]/g, "-")}-scale.json`,
    JSON.stringify(
      {
        command: "npx tsx scripts/verify-scale.ts (during 500-gw MQTT + 30-plant TCP load)",
        criteria: ["S1", "S2", "S3", "S4", "S5"],
        results,
        context: { fleetSize, latestAllMs: lat, scaleGateways: scaleGw.length, scaleMeters: meterTotal, sclDevices: sclRows.length, rssMb },
        summary: `${passed}/${results.length} checks passed`,
      },
      null,
      2,
    ),
  );
  console.log(ok ? `\nALL ${results.length} CHECKS PASSED` : `\n${results.length - passed} CHECK(S) FAILED`);
  await store.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
