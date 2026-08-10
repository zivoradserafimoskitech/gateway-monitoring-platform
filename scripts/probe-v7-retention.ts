// v7/C5 probe: retention + downsampling.
// Fixtures 120 days in the past (beyond the default 90-day retention):
//   day1 2026-04-12: counters 100,105,115,125,130 across 3 hours  → 30 kWh
//   day2 2026-04-13: 140,150,RESET→5,20                            → 35 kWh + counterReset
// Expectations:
//   1. baseline raw report (private method) = 30 / 35+reset
//   2. public dailyReport BEFORE rollup = empty (old days read hourly store)
//   3. purgeRaw rolls up 6 hourly rows and deletes all 9 raw rows
//   4. public dailyReport AFTER purge = same 30 / 35+reset (from hourly)
//   5. rollup is idempotent (re-run after purge keeps 6 rows, values intact)
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { gateways, meters, telemetry, telemetryHourly } from "../db/schema";
import { and, eq, sql as dsql } from "drizzle-orm";
import { purgeRaw, rollupRange } from "../api/telemetry/rollup";

async function main() {
  const db = getDb();
  let fails = 0;
  const probe = (n: string, ok: boolean, d: unknown) => {
    console.log(ok ? "PASS" : "FAIL", n, "->", JSON.stringify(d).slice(0, 220));
    if (!ok) fails++;
  };

  const g = await db.insert(gateways).values({ uid: "gw-ret-probe", name: "ret probe", model: "TCP", transport: "tcp", topicPrefix: "-" }).$returningId();
  const m = await db.insert(meters).values({ gatewayId: g[0].id, name: "ret meter", model: "PEM3000", modbusAddress: 1 }).$returningId();
  const meterId = m[0].id;

  const rows: [string, number][] = [
    ["2026-04-12T10:00:00Z", 100], ["2026-04-12T10:30:00Z", 105],
    ["2026-04-12T11:00:00Z", 115], ["2026-04-12T11:30:00Z", 125],
    ["2026-04-12T12:00:00Z", 130],
    ["2026-04-13T10:00:00Z", 140], ["2026-04-13T11:00:00Z", 150],
    ["2026-04-13T12:00:00Z", 5],   ["2026-04-13T12:30:00Z", 20],
  ];
  await db.insert(telemetry).values(rows.map(([ts, e]) => ({ meterId, ts: new Date(ts), energyImportKwh: e, activePowerKw: 1, powerFactor: 0.9 })));

  const { getTelemetryStore } = await import("../api/telemetry");
  const store = getTelemetryStore();
  const from = new Date("2026-04-11T00:00:00Z");
  const to = new Date("2026-04-14T00:00:00Z");

  // 1. baseline from raw (bypass the retention routing — private is compile-time only)
  const baseline = await (store as unknown as { dailyReportRaw: (a: number, b: Date, c: Date) => Promise<{ day: string; importKwh: number | null; counterReset: boolean }[]> }).dailyReportRaw(meterId, from, to);
  const b1 = baseline.find((d) => d.day === "2026-04-12");
  const b2 = baseline.find((d) => d.day === "2026-04-13");
  probe("baseline raw: day1=30, day2=35+reset", b1?.importKwh === 30 && b2?.importKwh === 35 && b2?.counterReset === true, baseline.map((d) => [d.day, d.importKwh, d.counterReset]));

  // 2. public report before rollup → old days live in the (empty) hourly store
  const pre = await store.dailyReport(meterId, from, to);
  probe("public report before rollup is empty (hourly not populated yet)", pre.length === 0, pre.map((d) => [d.day, d.importKwh]));

  // 3. purge (rolls up, then deletes raw)
  const cutoff = new Date("2026-04-14T00:00:00Z");
  const { rolledHours, deleted } = await purgeRaw(cutoff);
  const rawLeft = await db.select({ n: dsql<number>`count(*)` }).from(telemetry).where(eq(telemetry.meterId, meterId));
  const hourly = await db.select({ n: dsql<number>`count(*)` }).from(telemetryHourly).where(eq(telemetryHourly.meterId, meterId));
  probe("purgeRaw deleted all 9 raw rows", deleted === 9 && Number(rawLeft[0].n) === 0, { deleted, rawLeft: Number(rawLeft[0].n) });
  probe("rollup produced 6 hourly rows", Number(hourly[0].n) === 6, { hourly: Number(hourly[0].n), rolledHours });

  // 4. public report after purge → same numbers from hourly aggregates
  const post = await store.dailyReport(meterId, from, to);
  const p1 = post.find((d) => d.day === "2026-04-12");
  const p2 = post.find((d) => d.day === "2026-04-13");
  probe("post-purge report from hourly: day1=30, day2=35+reset", p1?.importKwh === 30 && p2?.importKwh === 35 && p2?.counterReset === true, post.map((d) => [d.day, d.importKwh, d.counterReset]));
  probe("post-purge matches raw baseline", JSON.stringify(post.map((d) => [d.day, d.importKwh, d.counterReset])) === JSON.stringify(baseline.map((d) => [d.day, d.importKwh, d.counterReset])), { post: post.length, baseline: baseline.length });

  // 5. idempotency: re-rollup keeps 6 rows and same energy
  await rollupRange(new Date("2026-04-12T00:00:00Z"), cutoff);
  const hourly2 = await db.select({ n: dsql<number>`count(*)` }).from(telemetryHourly).where(eq(telemetryHourly.meterId, meterId));
  const post2 = await store.dailyReport(meterId, from, to);
  const q1 = post2.find((d) => d.day === "2026-04-12");
  probe("rollup idempotent (6 rows, energy unchanged)", Number(hourly2[0].n) === 6 && q1?.importKwh === 30, { hourly: Number(hourly2[0].n), day1: q1?.importKwh });

  await db.delete(telemetryHourly).where(eq(telemetryHourly.meterId, meterId));
  await db.delete(telemetry).where(eq(telemetry.meterId, meterId));
  await db.delete(meters).where(eq(meters.id, meterId));
  await db.delete(gateways).where(eq(gateways.id, g[0].id));
  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
