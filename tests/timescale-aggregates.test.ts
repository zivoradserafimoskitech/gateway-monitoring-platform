// Integration test for the TimescaleDB store's aggregate path.
//
// Runs only when TIMESCALE_TEST_URL points at a live TimescaleDB — the CI
// "timescale" job provides one as a service container. Without it the suite
// skips, so the test is inert on a developer machine with no Postgres.
//
// What it pins:
//   1. db/timescale/001 + 002 apply cleanly (the continuous aggregate and the
//      telemetry_hourly_energy view are valid SQL against a real TimescaleDB —
//      nothing else in the repository can catch a typo in them).
//   2. The aggregate's delta/reset reconstruction from first/last/min/max
//      equals the window-function math over raw rows, including a counter
//      reset inside one hour and one across an hour boundary.
//   3. dailyReport and energyIntervals return the SAME numbers whether they
//      are answered from raw rows or from the aggregate. That equality is the
//      whole point: past the 90-day retention only the aggregate survives, and
//      a report that changes its answer at the cutoff is a billing bug.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { TimescaleTelemetryStore } from "../api/telemetry/timescale-store";
import type { DailyReportRow, EnergyIntervalBucket } from "../api/telemetry/types";

const URL = process.env.TIMESCALE_TEST_URL;
// The CI job sets TIMESCALE_REQUIRED so a missing/unreachable service
// container fails loudly: a suite that silently skips itself would make the
// job green for exactly the reason it exists to catch.
if (!URL && process.env.TIMESCALE_REQUIRED) {
  throw new Error("TIMESCALE_REQUIRED is set but TIMESCALE_TEST_URL is empty — no database to test against");
}
const METER = 4242;
// A fixed past day keeps the fixture independent of when the suite runs.
const DAY0 = Date.UTC(2025, 0, 15);
const H = 3_600_000;

/** Apply a .sql file statement by statement. */
async function applyFile(pool: Pool, path: string) {
  // Comments are stripped BEFORE splitting: both files contain commented-out
  // statements that end in a semicolon, which would otherwise cut a real
  // statement in half.
  const sql = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  // One statement per round trip on purpose: a multi-statement query string is
  // wrapped in an implicit transaction, and refresh_continuous_aggregate()
  // cannot run inside one.
  for (const s of statements) await pool.query(s);
}

type Sample = { ts: Date; e: number; p: number; pf: number };

/** 15-minute samples; `e` is the import counter, reset where the fixture says so. */
function fixture(): Sample[] {
  const out: Sample[] = [];
  let e = 0;
  for (let i = 0; i < 96; i++) {
    const ts = new Date(DAY0 + i * 15 * 60_000);
    const hour = Math.floor(i / 4);
    const slot = i % 4;
    // Meter swap at 13:30 — the counter restarts from zero mid-hour, which is
    // the case the min/max reconstruction has to detect without a lag().
    if (hour === 13 && slot === 2) e = 0;
    // Gateway swap between 20:00 and 21:00 — the drop lands on an hour
    // boundary instead, where only the inter-hour lag() can see it.
    else if (hour === 21 && slot === 0) e = 0;
    else if (i > 0) e += 0.25;
    out.push({ ts, e, p: 1 + (i % 5) * 0.1, pf: 0.9 + (i % 3) * 0.02 });
  }
  return out;
}

const d = URL ? describe : describe.skip;

d("TimescaleDB continuous aggregates", () => {
  let pool: Pool;
  let store: TimescaleTelemetryStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    await pool.query("drop materialized view if exists telemetry_hourly cascade");
    await pool.query("drop materialized view if exists telemetry_daily cascade");
    await pool.query("drop table if exists telemetry cascade");
    await pool.query("create extension if not exists timescaledb");
    await applyFile(pool, "db/timescale/001_init.sql");
    await applyFile(pool, "db/timescale/002_hourly_energy_rollup.sql");

    for (const s of fixture()) {
      await pool.query(
        `insert into telemetry (ts, meter_id, active_power_kw, power_factor, energy_import_kwh, energy_export_kwh)
         values ($1, $2, $3, $4, $5, 0)`,
        [s.ts, METER, s.p, s.pf, s.e],
      );
    }
    await pool.query("call refresh_continuous_aggregate('telemetry_hourly', null, null)");
    store = new TimescaleTelemetryStore(URL!);
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await pool?.end();
  });

  it("materializes one aggregate row per hour", async () => {
    const { rows } = await pool.query(
      "select count(*)::int as n from telemetry_hourly_energy where meter_id = $1",
      [METER],
    );
    expect(rows[0].n).toBe(24);
  });

  it("detects a counter reset inside an hour and one across an hour boundary", async () => {
    const { rows } = await pool.query(
      `select extract(hour from hour_start at time zone 'UTC')::int as h, counter_reset, energy_import_delta_kwh as d
       from telemetry_hourly_energy where meter_id = $1 order by hour_start`,
      [METER],
    );
    const byHour = new Map(rows.map((r) => [r.h, r]));
    // 13:30 restart: first=+0.25 over 13:00, min=0 → seen by the min/max rule.
    expect(byHour.get(13).counter_reset).toBe(true);
    // The rising runs either side of the reset, not the whole pre-reset range.
    expect(Number(byHour.get(13).d)).toBeCloseTo(0.5, 6);
    // 21:00 restart lands between hours, so the hour itself looks monotonic;
    // the query layer catches it with lag() over the previous hour's last.
    expect(byHour.get(21).counter_reset).toBe(false);
    // An ordinary hour: four samples, three 0.25 steps inside it.
    expect(Number(byHour.get(5).d)).toBeCloseTo(0.75, 6);
    expect(byHour.get(5).counter_reset).toBe(false);
  });

  it("reports the same day from raw rows and from the aggregate", async () => {
    const from = new Date(DAY0);
    const to = new Date(DAY0 + 24 * H);
    type Privates = {
      dailyReportRaw(m: number, f: Date, t: Date): Promise<DailyReportRow[]>;
      dailyReportFromHourly(m: number, f: Date, t: Date): Promise<DailyReportRow[]>;
    };
    const inner = store as unknown as Privates;
    const raw = await inner.dailyReportRaw(METER, from, to);
    const agg = await inner.dailyReportFromHourly(METER, from, to);
    expect(raw).toHaveLength(1);
    expect(agg).toHaveLength(1);
    expect(agg[0].day).toBe(raw[0].day);
    expect(agg[0].samples).toBe(raw[0].samples);
    expect(agg[0].importKwh!).toBeCloseTo(raw[0].importKwh!, 2);
    expect(agg[0].counterReset).toBe(true);
    expect(raw[0].counterReset).toBe(true);
    expect(agg[0].avgPowerFactor!).toBeCloseTo(raw[0].avgPowerFactor!, 2);
    // Both resets discard the pre-reset counter, so the day is the sum of the
    // three rising runs rather than the last reading.
    expect(raw[0].importKwh!).toBeGreaterThan(0);
  });

  it("returns the same settlement intervals from raw rows and from the aggregate", async () => {
    const from = new Date(DAY0);
    const to = new Date(DAY0 + 24 * H);
    type Privates = {
      energyIntervalsRaw(m: number, f: Date, t: Date, b: number): Promise<EnergyIntervalBucket[]>;
      energyIntervalsHourly(m: number, f: Date, t: Date, b: number): Promise<EnergyIntervalBucket[]>;
    };
    const inner = store as unknown as Privates;
    const raw = await inner.energyIntervalsRaw(METER, from, to, 60);
    const agg = await inner.energyIntervalsHourly(METER, from, to, 60);
    const rawByStart = new Map(raw.map((b) => [b.bucketStartSec, b]));
    expect(agg.length).toBeGreaterThan(0);
    for (const b of agg) {
      const r = rawByStart.get(b.bucketStartSec);
      expect(r, `no raw bucket at ${b.bucketStartSec}`).toBeDefined();
      expect(b.importKwh!).toBeCloseTo(r!.importKwh!, 2);
      expect(b.samples).toBe(r!.samples);
      expect(b.avgPowerKw!).toBeCloseTo(r!.avgPowerKw!, 2);
    }
  });

  it("expands sub-hour buckets over the aggregated range and marks them estimated", async () => {
    type Privates = {
      energyIntervalsHourly(m: number, f: Date, t: Date, b: number): Promise<EnergyIntervalBucket[]>;
    };
    const inner = store as unknown as Privates;
    const from = new Date(DAY0);
    const to = new Date(DAY0 + 2 * H);
    const hourly = await inner.energyIntervalsHourly(METER, from, to, 60);
    const quarter = await inner.energyIntervalsHourly(METER, from, to, 15);
    expect(quarter).toHaveLength(hourly.length * 4);
    expect(quarter.every((b) => b.estimated)).toBe(true);
    const total = quarter.reduce((a, b) => a + (b.importKwh ?? 0), 0);
    const hourlyTotal = hourly.reduce((a, b) => a + (b.importKwh ?? 0), 0);
    expect(total).toBeCloseTo(hourlyTotal, 2);
  });
});
