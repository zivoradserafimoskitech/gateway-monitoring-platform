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
import type { DailyReportRow, EnergyIntervalBucket, HistoryPoint } from "../api/telemetry/types";

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
    await applyFile(pool, "db/timescale/003_hourly_chart_columns.sql");

    for (const s of fixture()) {
      await pool.query(
        `insert into telemetry
           (ts, meter_id, active_power_kw, power_factor, voltage_l1, current_l1, frequency_hz,
            energy_import_kwh, energy_export_kwh, values_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)`,
        [s.ts, METER, s.p, s.pf, 230 + s.p, s.p * 2, 50, s.e, JSON.stringify({ batteryPowerKw: -s.p })],
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


  it("draws the same chart from raw rows and from the aggregate", async () => {
    // The whole point of the split: a chart must not change its answer at the
    // cutoff. Hourly buckets so both paths are directly comparable.
    type Privates = {
      historyRaw(m: number, f: Date, t: Date, b: number, k?: string): Promise<HistoryPoint[]>;
      historyFromHourly(m: number, f: Date, t: Date, b: number, k?: string): Promise<HistoryPoint[]>;
    };
    const inner = store as unknown as Privates;
    const from = new Date(DAY0);
    const to = new Date(DAY0 + 24 * H);
    const raw = await inner.historyRaw(METER, from, to, 3600);
    const agg = await inner.historyFromHourly(METER, from, to, 3600);
    expect(agg).toHaveLength(raw.length);
    const rawByTs = new Map(raw.map((p) => [p.ts.getTime(), p]));
    for (const p of agg) {
      const r = rawByTs.get(p.ts.getTime());
      expect(r, `no raw point at ${p.ts.toISOString()}`).toBeDefined();
      expect(p.samples).toBe(r!.samples);
      expect(p.activePowerKw!).toBeCloseTo(r!.activePowerKw!, 6);
      expect(p.voltageL1!).toBeCloseTo(r!.voltageL1!, 6);
      expect(p.currentL1!).toBeCloseTo(r!.currentL1!, 6);
      expect(p.powerFactor!).toBeCloseTo(r!.powerFactor!, 6);
      expect(p.frequencyHz!).toBeCloseTo(r!.frequencyHz!, 6);
    }
  });

  it("keeps a BESS chart alive past the cutoff", async () => {
    // batteryPowerKw lives in values_json, not in a column. Before 003 the
    // aggregate had no place for it, so a battery's primary series went flat
    // past the cutoff while a meter's did not.
    type Privates = {
      historyRaw(m: number, f: Date, t: Date, b: number, k?: string): Promise<HistoryPoint[]>;
      historyFromHourly(m: number, f: Date, t: Date, b: number, k?: string): Promise<HistoryPoint[]>;
    };
    const inner = store as unknown as Privates;
    const from = new Date(DAY0);
    // Ends one millisecond BEFORE 06:00, so the range holds whole hours only.
    // With `to` exactly on the hour, raw picks up the single 06:00 sample as a
    // 25th, one-sample bucket while the aggregate reports that hour in full —
    // the two are then legitimately different and prove nothing. In the real
    // split that partial bucket cannot arise: history() hands the aggregate a
    // bound that stops before the cutoff's own hour (aggregateUpperBound).
    const to = new Date(DAY0 + 6 * H - 1);
    const raw = await inner.historyRaw(METER, from, to, 3600, "batteryPowerKw");
    const agg = await inner.historyFromHourly(METER, from, to, 3600, "batteryPowerKw");
    expect(agg.length).toBeGreaterThan(0);
    const rawByTs = new Map(raw.map((p) => [p.ts.getTime(), p]));
    for (const p of agg) {
      const r = rawByTs.get(p.ts.getTime())!;
      expect(p.powerKw, "battery series must not be null past the cutoff").not.toBeNull();
      expect(p.powerKw!).toBeCloseTo(r.powerKw!, 6);
      // The fixture charges at negative power, so this is not accidentally
      // reading the active-power column instead.
      expect(p.powerKw!).toBeLessThan(0);
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

// §9.14: a tenant's telemetry has to be deletable and exportable where
// production actually keeps it. The first version of both talked to the MySQL
// telemetry table, which is empty under TELEMETRY_STORE=timescale — a purge
// reported success and deleted nothing, and an export carried no telemetry.
d("TimescaleDB store: deleting and exporting a tenant's telemetry", () => {
  const GONE = 5151;
  const KEPT = 5252;
  const COMPRESSED = 5353;
  // Recent, so neither the retention nor the compression policy can touch the
  // fixture while the suite runs; compression is applied explicitly below.
  const T = Math.floor(Date.now() / H) * H - 48 * H;
  let pool: Pool;
  let store: TimescaleTelemetryStore;

  const count = async (from: string, meter: number) =>
    (await pool.query(`select count(*)::int as n from ${from} where meter_id = $1`, [meter])).rows[0].n as number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    for (const meter of [GONE, KEPT, COMPRESSED]) {
      for (let i = 0; i < 8; i++) {
        await pool.query(
          `insert into telemetry (ts, meter_id, active_power_kw, energy_import_kwh, values_json)
           values ($1, $2, $3, $4, $5)`,
          [new Date(T + i * 15 * 60_000), meter, 1 + i, i * 0.25, JSON.stringify({ socPercent: 50 + i })],
        );
      }
    }
    // The same sample twice, as at-least-once ingestion can store it. An
    // export paged by (ts, meter) would lose one of them at a page boundary.
    await pool.query("insert into telemetry (ts, meter_id, active_power_kw) values ($1, $2, 1)", [new Date(T), GONE]);
    await pool.query("call refresh_continuous_aggregate('telemetry_hourly', null, null)");
    await pool.query("call refresh_continuous_aggregate('telemetry_daily', null, null)");
    store = new TimescaleTelemetryStore(URL!);
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await pool?.end();
  });

  it("exports every raw row in time order, duplicates included, a page at a time", async () => {
    const pages: Record<string, unknown>[][] = [];
    for await (const page of store.exportRaw([GONE], new Date(T), new Date(T + 2 * H), 3)) pages.push(page);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 3]);
    const rows = pages.flat();
    expect(rows.every((r) => Number(r.meter_id) === GONE)).toBe(true);
    const times = rows.map((r) => new Date(r.ts as string | Date).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Every stored column comes through, the open values map included.
    expect(rows.some((r) => (r.values_json as { socPercent?: number } | null)?.socPercent === 57)).toBe(true);
  });

  it("gives its connection back when the caller stops reading early", async () => {
    // The pool holds ten clients. One left behind per abandoned export — or
    // handed back inside its open transaction — would stall this loop.
    for (let i = 0; i < 12; i++) {
      for await (const page of store.exportRaw([KEPT], new Date(T), new Date(T + 2 * H), 2)) {
        expect(page).toHaveLength(2);
        break;
      }
    }
    const { rows } = await pool.query("select 1 as ok");
    expect(rows[0].ok).toBe(1);
  });

  it("deletes the raw rows and every rollup built from them, for those devices only", async () => {
    expect(await count("telemetry_hourly", GONE)).toBeGreaterThan(0);
    expect(await count("telemetry_daily", GONE)).toBeGreaterThan(0);
    const keptHourly = await count("telemetry_hourly", KEPT);
    const keptDaily = await count("telemetry_daily", KEPT);

    const removed = await store.deleteMeterData([GONE]);
    expect(removed.raw).toBe(9);
    expect(removed.rollups).toBeGreaterThan(0);

    expect(await count("telemetry", GONE)).toBe(0);
    expect(await count("telemetry_hourly", GONE)).toBe(0);
    expect(await count("telemetry_daily", GONE)).toBe(0);
    // Somebody else's history is untouched.
    expect(await count("telemetry", KEPT)).toBe(8);
    expect(await count("telemetry_hourly", KEPT)).toBe(keptHourly);
    expect(await count("telemetry_daily", KEPT)).toBe(keptDaily);
  });

  it("deletes from compressed chunks as well", async () => {
    // Production compresses everything older than a week, which is most of
    // any tenant's history.
    await pool.query("select compress_chunk(c, true) from show_chunks('telemetry') c");
    const { rows } = await pool.query(
      "select count(*)::int as n from timescaledb_information.chunks where hypertable_name = 'telemetry' and is_compressed",
    );
    expect(rows[0].n).toBeGreaterThan(0);
    const removed = await store.deleteMeterData([COMPRESSED]);
    expect(removed.raw).toBe(8);
    expect(await count("telemetry", COMPRESSED)).toBe(0);
    expect(await count("telemetry", KEPT)).toBe(8);
  });
});
