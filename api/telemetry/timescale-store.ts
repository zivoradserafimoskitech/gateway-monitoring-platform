// TimescaleDB telemetry store — production path for 300–500+ gateways.
//
// Telemetry lives in a `telemetry` hypertable (see db/timescale/001_init.sql):
//   - automatic time partitioning + (meter_id, ts) index
//   - native compression after 7 days (~10x)
//   - retention policy: raw data dropped after 90 days
//   - continuous aggregates: `telemetry_hourly` (+ the telemetry_hourly_energy
//     view over it, db/timescale/002) carries the first/last/min/max counters
//     that daily reports past the 90-day raw cutoff are rebuilt from;
//     `telemetry_daily` stays available for ad-hoc/BI queries
//
// Activated by setting: TELEMETRY_STORE=timescale + TIMESCALE_URL=postgres://...
import { Pool } from "pg";
import type {
  DailyReportOpts,
  DailyReportRow,
  EnergyIntervalBucket,
  FreshTelemetry,
  HistoryPoint,
  MetricSeriesBucket,
  TelemetryRow,
  TelemetryStore,
  TrendPoint,
} from "./types";
import { COLUMN_BACKED_METRICS, assertValidMetricKeys } from "./types";
import { env } from "../lib/env";
import { retentionCutoff } from "./retention";
import { mergeDayRows, mergeEnergyBuckets } from "./merge";

const COLS = [
  "ts",
  "meter_id",
  "voltage_l1",
  "voltage_l2",
  "voltage_l3",
  "current_l1",
  "current_l2",
  "current_l3",
  "active_power_kw",
  "reactive_power_kvar",
  "apparent_power_kva",
  "power_factor",
  "frequency_hz",
  "energy_import_kwh",
  "energy_export_kwh",
  "demand_kw",
  "raw",
  // v5 finding #5: the Timescale store used to DROP the open values map —
  // switching stores silently lost every inverter/BESS/weather register.
  "values_json",
] as const;

export class TimescaleTelemetryStore implements TelemetryStore {
  private pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 10 });
  }

  async writeBatch(rows: TelemetryRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      const base = i * COLS.length;
      values.push(
        r.ts,
        r.meterId,
        r.values.voltageL1 ?? null,
        r.values.voltageL2 ?? null,
        r.values.voltageL3 ?? null,
        r.values.currentL1 ?? null,
        r.values.currentL2 ?? null,
        r.values.currentL3 ?? null,
        r.values.activePowerKw ?? null,
        r.values.reactivePowerKvar ?? null,
        r.values.apparentPowerKva ?? null,
        r.values.powerFactor ?? null,
        r.values.frequencyHz ?? null,
        r.values.energyImportKwh ?? null,
        r.values.energyExportKwh ?? null,
        r.values.demandKw ?? null,
        r.raw === undefined ? null : JSON.stringify(r.raw),
        JSON.stringify(r.values),
      );
      return `(${COLS.map((_, j) => `$${base + j + 1}`).join(",")})`;
    });
    await this.pool.query(
      `insert into telemetry (${COLS.join(",")}) values ${tuples.join(",")}`,
      values,
    );
  }

  async latest(meterId: number): Promise<TelemetryRow | null> {
    const { rows } = await this.pool.query(
      `select * from telemetry where meter_id = $1 order by ts desc limit 1`,
      [meterId],
    );
    const r = rows[0];
    if (!r) return null;
    // Same merge rule as the MySQL store: fixed columns first, values_json
    // (open key map) wins on conflicts so corrected decodes propagate.
    const json = (r.values_json ?? {}) as Record<string, number>;
    return {
      meterId: r.meter_id,
      ts: r.ts,
      values: {
        voltageL1: r.voltage_l1 ?? undefined,
        voltageL2: r.voltage_l2 ?? undefined,
        voltageL3: r.voltage_l3 ?? undefined,
        currentL1: r.current_l1 ?? undefined,
        currentL2: r.current_l2 ?? undefined,
        currentL3: r.current_l3 ?? undefined,
        activePowerKw: r.active_power_kw ?? undefined,
        reactivePowerKvar: r.reactive_power_kvar ?? undefined,
        apparentPowerKva: r.apparent_power_kva ?? undefined,
        powerFactor: r.power_factor ?? undefined,
        frequencyHz: r.frequency_hz ?? undefined,
        energyImportKwh: r.energy_import_kwh ?? undefined,
        energyExportKwh: r.energy_export_kwh ?? undefined,
        demandKw: r.demand_kw ?? undefined,
        ...json,
      },
    };
  }

  // audit wave 6: same freshForControl contract as the MySQL store — one
  // latest-style query, age against the app clock. ts here is timestamptz
  // written from the app-supplied Date (writeBatch binds r.ts), so the age
  // comparison is epoch-based and timezone-proof.
  async freshForControl(meterId: number, maxAgeMs: number = env.controlTelemetryMaxAgeMs): Promise<FreshTelemetry> {
    const row = await this.latest(meterId);
    if (!row) return { row: null, fresh: false, ageMs: null };
    const ageMs = Date.now() - row.ts.getTime();
    return { row, fresh: ageMs <= maxAgeMs, ageMs };
  }

  async latestAll(): Promise<Map<number, TelemetryRow>> {
    // DISTINCT ON + the (meter_id, ts desc) index = one index row per meter
    const { rows } = await this.pool.query(
      `select distinct on (meter_id) meter_id, ts, active_power_kw, energy_import_kwh, values_json
       from telemetry order by meter_id, ts desc`,
    );
    const map = new Map<number, TelemetryRow>();
    for (const r of rows) {
      const json = (r.values_json ?? {}) as Record<string, number>;
      map.set(r.meter_id, {
        meterId: r.meter_id,
        ts: r.ts,
        values: {
          ...json,
          activePowerKw: r.active_power_kw ?? json.activePowerKw,
          energyImportKwh: r.energy_import_kwh ?? json.energyImportKwh,
        },
      });
    }
    return map;
  }

  async history(
    meterId: number,
    from: Date,
    to: Date,
    bucketSec: number,
    powerKey?: string,
  ): Promise<HistoryPoint[]> {
    // #20: primary power key — column fast path, values_json for the rest.
    const key = powerKey && /^[A-Za-z0-9_]+$/.test(powerKey) ? powerKey : "activePowerKw";
    const powerExpr =
      key === "activePowerKw"
        ? `avg(active_power_kw)`
        : `avg((values_json->>'${key}')::double precision)`;
    const { rows } = await this.pool.query(
      `select (extract(epoch from time_bucket($4 * interval '1 second', ts)))::bigint as bucket,
              ${powerExpr} as "powerKw",
              avg(active_power_kw) as "activePowerKw",
              avg(voltage_l1) as "voltageL1",
              avg(current_l1) as "currentL1",
              avg(power_factor) as "powerFactor",
              avg(frequency_hz) as "frequencyHz",
              max(energy_import_kwh) as "energyImportKwh",
              count(*)::int as samples
       from telemetry
       where meter_id = $1 and ts >= $2 and ts <= $3
       group by bucket order by bucket`,
      [meterId, from, to, bucketSec],
    );
    return rows.map((r) => ({
      ts: new Date(Number(r.bucket) * 1000),
      powerKw: r.powerKw === null ? null : Number(r.powerKw),
      activePowerKw: r.activePowerKw === null ? null : Number(r.activePowerKw),
      voltageL1: r.voltageL1 === null ? null : Number(r.voltageL1),
      currentL1: r.currentL1 === null ? null : Number(r.currentL1),
      powerFactor: r.powerFactor === null ? null : Number(r.powerFactor),
      frequencyHz: r.frequencyHz === null ? null : Number(r.frequencyHz),
      energyImportKwh: r.energyImportKwh === null ? null : Number(r.energyImportKwh),
      samples: Number(r.samples),
    }));
  }

  async powerTrend(from: Date, bucketSec: number): Promise<TrendPoint[]> {
    const { rows } = await this.pool.query(
      `select (extract(epoch from time_bucket($2 * interval '1 second', ts)))::bigint as bucket,
              meter_id, avg(active_power_kw) as "avgKw"
       from telemetry
       where ts >= $1
       group by bucket, meter_id order by bucket`,
      [from, bucketSec],
    );
    return rows.map((r) => ({
      bucketSec: Number(r.bucket),
      meterId: r.meter_id,
      avgKw: r.avgKw === null ? null : Number(r.avgKw),
    }));
  }

  async firstEnergySince(meterId: number, from: Date): Promise<number | null> {
    const { rows } = await this.pool.query(
      `select energy_import_kwh as v from telemetry
       where meter_id = $1 and ts >= $2 and energy_import_kwh is not null
       order by ts asc limit 1`,
      [meterId, from],
    );
    return rows[0]?.v ?? null;
  }

  async firstEnergyAll(since: Date): Promise<Map<number, number>> {
    // #13: counter key per device type — column for meters, values_json
    // counters for inverters (energyTotalKwh) and BESS (dischargeEnergyTotalKwh).
    const { rows } = await this.pool.query(
      `select distinct on (meter_id) meter_id,
         coalesce(energy_import_kwh,
                  (values_json->>'energyTotalKwh')::double precision,
                  (values_json->>'dischargeEnergyTotalKwh')::double precision) as e
       from telemetry where ts >= $1
       order by meter_id, ts asc`,
      [since],
    );
    const map = new Map<number, number>();
    for (const r of rows) if (r.e !== null) map.set(r.meter_id, Number(r.e));
    return map;
  }

  // Days newer than the raw-retention cutoff are computed from raw rows; older
  // days are rebuilt from the telemetry_hourly continuous aggregate, because
  // 001_init.sql's retention policy has already dropped the raw chunks. Before
  // this split the Timescale store returned an EMPTY report for anything past
  // 90 days while the MySQL store returned data — same API, different answer.
  // Ranges straddling the cutoff are split and merged per day (merge.ts).
  async dailyReport(meterId: number, from: Date, to: Date, opts?: DailyReportOpts): Promise<DailyReportRow[]> {
    const cutoff = retentionCutoff();
    const parts: DailyReportRow[][] = [];
    if (from < cutoff) {
      parts.push(await this.dailyReportFromHourly(meterId, from, to < cutoff ? to : cutoff, opts));
    }
    if (to >= cutoff) {
      parts.push(await this.dailyReportRaw(meterId, from > cutoff ? from : cutoff, to, opts));
    }
    return mergeDayRows(parts);
  }

  // Day bucket expression, shared by the raw and the hourly query. `col` is the
  // timestamp column of the source relation. Boundaries are inlined as literal
  // timestamps rather than bound: the CASE arm count varies per request, and
  // the values are ISO strings produced by the server from its own Date
  // objects (v7/C8) — never caller text.
  private dayBucketExpr(col: string, opts?: DailyReportOpts): string {
    if (!opts?.dayBuckets?.length) return `floor(extract(epoch from ${col}) / 86400)`;
    return (
      "case " +
      opts.dayBuckets
        .map(
          (b) =>
            `when ${col} >= '${b.startUtc.toISOString()}'::timestamptz and ${col} < '${b.endUtc.toISOString()}'::timestamptz then '${b.label}'`,
        )
        .join(" ") +
      " else null end"
    );
  }

  private mapDayRows(rows: Record<string, unknown>[], localMode: boolean): DailyReportRow[] {
    return rows
      .filter((r) => r.dayBucket !== null)
      .map((r) => ({
        day: localMode
          ? String(r.dayBucket)
          : new Date(Number(r.dayBucket) * 86_400_000).toISOString().slice(0, 10),
        importKwh: r.importKwh === null ? null : Math.round(Number(r.importKwh) * 100) / 100,
        exportKwh: r.exportKwh === null ? null : Math.round(Number(r.exportKwh) * 100) / 100,
        maxDemandKw: r.maxDemand === null ? null : Math.round(Number(r.maxDemand) * 100) / 100,
        // #21: derived-from-active-power marker (no demand register samples)
        demandDerived: Number(r.demandSamples ?? 0) === 0 && r.maxDemand !== null,
        counterReset: r.counterReset === true,
        avgPowerFactor: r.avgPf === null ? null : Math.round(Number(r.avgPf) * 1000) / 1000,
        samples: Number(r.samples),
      }));
  }

  private async dailyReportRaw(meterId: number, from: Date, to: Date, opts?: DailyReportOpts): Promise<DailyReportRow[]> {
    // v7/C7: same non-negative-delta logic as the MySQL store (window function
    // over raw rows — the continuous aggregate's min/max can't express resets).
    // Days are UTC epoch buckets (#8 parity with the MySQL store).
    const bucket = this.dayBucketExpr("ts", opts);
    const { rows } = await this.pool.query(
      `with ordered as (
         select ts, energy_import_kwh as e, energy_export_kwh as x,
                lag(energy_import_kwh) over (order by ts) as e_prev,
                lag(energy_export_kwh) over (order by ts) as x_prev,
                coalesce(demand_kw, active_power_kw) as demand,
                demand_kw as demand_raw, power_factor as pf
         from telemetry
         where meter_id = $1 and ts >= $2::timestamptz and ts <= $3::timestamptz
       )
       select ${bucket} as "dayBucket",
              sum(greatest(e - e_prev, 0)) as "importKwh",
              sum(greatest(x - x_prev, 0)) as "exportKwh",
              bool_or(e - e_prev < -0.001 or x - x_prev < -0.001) as "counterReset",
              max(demand) as "maxDemand",
              count(demand_raw) as "demandSamples",
              avg(pf) as "avgPf",
              count(*) as samples
       from ordered
       group by "dayBucket"
       order by "dayBucket"`,
      [meterId, from, to],
    );
    return this.mapDayRows(rows, !!opts?.dayBuckets?.length);
  }

  // Same report shape, rebuilt from telemetry_hourly_energy (db/timescale/002).
  // Energy per day = the stored intra-hour delta PLUS the inter-hour delta
  // between each hour's first counter and the previous hour's last, so counter
  // resets stay safe exactly like the raw query — identical math to the MySQL
  // store's dailyReportFromHourly, over the continuous aggregate instead of a
  // rollup table.
  private async dailyReportFromHourly(
    meterId: number,
    from: Date,
    to: Date,
    opts?: DailyReportOpts,
  ): Promise<DailyReportRow[]> {
    const bucket = this.dayBucketExpr("ts", opts);
    const { rows } = await this.pool.query(
      `with ordered as (
         select hour_start as ts,
                energy_import_delta_kwh as e_intra,
                energy_export_delta_kwh as x_intra,
                energy_import_first as e_first,
                energy_export_first as x_first,
                lag(energy_import_last) over (order by hour_start) as e_prev_last,
                lag(energy_export_last) over (order by hour_start) as x_prev_last,
                max_demand_kw as demand,
                demand_samples as demand_n,
                avg_power_factor as pf,
                samples,
                counter_reset as cr
         from telemetry_hourly_energy
         where meter_id = $1 and hour_start >= $2::timestamptz and hour_start <= $3::timestamptz
       )
       select ${bucket} as "dayBucket",
              sum(coalesce(e_intra, 0) + greatest(coalesce(e_first - e_prev_last, 0), 0)) as "importKwh",
              sum(coalesce(x_intra, 0) + greatest(coalesce(x_first - x_prev_last, 0), 0)) as "exportKwh",
              coalesce(bool_or(cr or e_first - e_prev_last < -0.001 or x_first - x_prev_last < -0.001), false) as "counterReset",
              max(demand) as "maxDemand",
              sum(demand_n) as "demandSamples",
              sum(pf * samples) / nullif(sum(samples), 0) as "avgPf",
              sum(samples) as samples
       from ordered
       group by "dayBucket"
       order by "dayBucket"`,
      [meterId, from, to],
    );
    return this.mapDayRows(rows, !!opts?.dayBuckets?.length);
  }

  // v8/D2: settlement energy intervals (same shape/semantics as the MySQL
  // store): raw rows for the recent range, hourly aggregates past the raw
  // retention cutoff, merged where a bucket straddles the two.
  async energyIntervals(meterId: number, from: Date, to: Date, bucketMin: number): Promise<EnergyIntervalBucket[]> {
    const cutoff = retentionCutoff();
    const parts: EnergyIntervalBucket[][] = [];
    if (from < cutoff) {
      parts.push(await this.energyIntervalsHourly(meterId, from, to < cutoff ? to : cutoff, bucketMin));
    }
    if (to >= cutoff) {
      parts.push(await this.energyIntervalsRaw(meterId, from > cutoff ? from : cutoff, to, bucketMin));
    }
    return mergeEnergyBuckets(parts);
  }

  private async energyIntervalsRaw(meterId: number, from: Date, to: Date, bucketMin: number): Promise<EnergyIntervalBucket[]> {
    const bucketSec = bucketMin * 60;
    const { rows } = await this.pool.query(
      `with ordered as (
         select ts,
                coalesce(energy_import_kwh, (values_json->>'energyImportKwh')::double precision) as e,
                coalesce(energy_export_kwh, (values_json->>'energyExportKwh')::double precision) as x,
                lag(coalesce(energy_import_kwh, (values_json->>'energyImportKwh')::double precision)) over (order by ts) as e_prev,
                lag(coalesce(energy_export_kwh, (values_json->>'energyExportKwh')::double precision)) over (order by ts) as x_prev,
                coalesce(active_power_kw, (values_json->>'activePowerKw')::double precision) as p
         from telemetry
         where meter_id = $1 and ts >= $2::timestamptz and ts <= $3::timestamptz
       )
       select floor(extract(epoch from ts) / ${bucketSec}) as b,
              sum(greatest(e - e_prev, 0)) as "importKwh",
              sum(greatest(x - x_prev, 0)) as "exportKwh",
              bool_or(e - e_prev < -0.001 or x - x_prev < -0.001) as "counterReset",
              avg(p) as "avgPower",
              count(*) as samples
       from ordered
       group by b
       order by b`,
      [meterId, from, to],
    );
    return rows.map((r) => ({
      bucketStartSec: Number(r.b) * bucketSec,
      importKwh: r.importKwh === null ? null : Math.round(Number(r.importKwh) * 1000) / 1000,
      exportKwh: r.exportKwh === null ? null : Math.round(Number(r.exportKwh) * 1000) / 1000,
      avgPowerKw: r.avgPower === null ? null : Math.round(Number(r.avgPower) * 1000) / 1000,
      samples: Number(r.samples),
      estimated: r.counterReset === true,
    }));
  }

  private async energyIntervalsHourly(meterId: number, from: Date, to: Date, bucketMin: number): Promise<EnergyIntervalBucket[]> {
    const hourFloor = new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000);
    if (bucketMin >= 60) {
      const bucketSec = bucketMin * 60;
      const { rows } = await this.pool.query(
        `with ordered as (
           select hour_start as ts,
                  energy_import_delta_kwh as e_intra,
                  energy_export_delta_kwh as x_intra,
                  energy_import_first as e_first,
                  energy_export_first as x_first,
                  lag(energy_import_last) over (order by hour_start) as e_prev_last,
                  lag(energy_export_last) over (order by hour_start) as x_prev_last,
                  avg_power_kw as p,
                  samples,
                  counter_reset as cr
           from telemetry_hourly_energy
           where meter_id = $1 and hour_start >= $2::timestamptz and hour_start < $3::timestamptz
         )
         select floor(extract(epoch from ts) / ${bucketSec}) as b,
                sum(coalesce(e_intra, 0) + greatest(coalesce(e_first - e_prev_last, 0), 0)) as "importKwh",
                sum(coalesce(x_intra, 0) + greatest(coalesce(x_first - x_prev_last, 0), 0)) as "exportKwh",
                coalesce(bool_or(cr or e_first - e_prev_last < -0.001 or x_first - x_prev_last < -0.001), false) as "counterReset",
                sum(p * samples) / nullif(sum(samples), 0) as "avgPower",
                sum(samples) as samples
           from ordered
           group by b
           order by b`,
        [meterId, hourFloor, to],
      );
      return rows.map((r) => ({
        bucketStartSec: Number(r.b) * bucketSec,
        importKwh: r.importKwh === null ? null : Math.round(Number(r.importKwh) * 1000) / 1000,
        exportKwh: r.exportKwh === null ? null : Math.round(Number(r.exportKwh) * 1000) / 1000,
        avgPowerKw: r.avgPower === null ? null : Math.round(Number(r.avgPower) * 1000) / 1000,
        samples: Number(r.samples),
        estimated: r.counterReset === true,
      }));
    }
    // Sub-hour buckets over the aggregated range: the rollup destroyed that
    // resolution, so spread each hour evenly and mark every bucket estimated
    // (same contract as the MySQL store).
    const perHour = await this.energyIntervalsHourly(meterId, hourFloor, to, 60);
    const sub = 60 / bucketMin;
    const out: EnergyIntervalBucket[] = [];
    for (const h of perHour) {
      for (let i = 0; i < sub; i++) {
        out.push({
          bucketStartSec: h.bucketStartSec + i * bucketMin * 60,
          importKwh: h.importKwh === null ? null : Math.round((h.importKwh / sub) * 1000) / 1000,
          exportKwh: h.exportKwh === null ? null : Math.round((h.exportKwh / sub) * 1000) / 1000,
          avgPowerKw: h.avgPowerKw,
          samples: Math.round(h.samples / sub),
          estimated: true,
        });
      }
    }
    return out;
  }

  // audit wave 4 (Task 4): multi-metric bucketed series (same shape/semantics
  // as the MySQL store). Keys are validated against METRIC_KEY_RE BEFORE any
  // interpolation — the whitelist IS the injection defence (keys are
  // identifiers, not bind values). Column-backed keys AVG the real indexed
  // column; other keys read values_json. Only non-empty buckets are returned.
  async metricSeries(meterId: number, from: Date, to: Date, bucketSec: number, keys: string[]): Promise<MetricSeriesBucket[]> {
    assertValidMetricKeys(keys);
    if (!Number.isInteger(bucketSec) || bucketSec <= 0) throw new Error("bucketSec must be a positive integer");
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const avgExprs = unique.map((k) => {
      const col = COLUMN_BACKED_METRICS[k];
      const inner = col ?? `(values_json->>'${k}')::double precision`; // k is whitelisted above
      return `avg(${inner}) as "${k}"`;
    });
    const { rows } = await this.pool.query(
      `select floor(extract(epoch from ts) / ${bucketSec}) as b, count(*)::int as samples, ${avgExprs.join(", ")}
       from telemetry
       where meter_id = $1 and ts >= $2::timestamptz and ts <= $3::timestamptz
       group by b
       order by b`,
      [meterId, from, to],
    );
    return rows.map((r) => ({
      bucketStartSec: Number(r.b) * bucketSec,
      values: Object.fromEntries(unique.map((k) => [k, r[k] == null ? null : Number(r[k])])),
      samples: Number(r.samples),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
