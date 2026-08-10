// TimescaleDB telemetry store — production path for 300–500+ gateways.
//
// Telemetry lives in a `telemetry` hypertable (see db/timescale/001_init.sql):
//   - automatic time partitioning + (meter_id, ts) index
//   - native compression after 7 days (~10x)
//   - retention policy: raw data dropped after 90 days
//   - continuous aggregate `telemetry_daily` powers reports and rollups
//
// Activated by setting: TELEMETRY_STORE=timescale + TIMESCALE_URL=postgres://...
import { Pool } from "pg";
import type {
  DailyReportOpts,
  DailyReportRow,
  EnergyIntervalBucket,
  HistoryPoint,
  TelemetryRow,
  TelemetryStore,
  TrendPoint,
} from "./types";

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

  async dailyReport(meterId: number, from: Date, to: Date, opts?: DailyReportOpts): Promise<DailyReportRow[]> {
    // v7/C7: same non-negative-delta logic as the MySQL store (window function
    // over raw rows — the continuous aggregate's min/max can't express resets).
    // Days are UTC epoch buckets (#8 parity with the MySQL store).
    const bucket = opts?.dayBuckets?.length
      ? "case " +
        opts.dayBuckets
          .map((b) => `when ts >= '${b.startUtc.toISOString()}'::timestamptz and ts < '${b.endUtc.toISOString()}'::timestamptz then '${b.label}'`)
          .join(" ") +
        " else null end"
      : "floor(extract(epoch from ts) / 86400)";
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
    const localMode = !!opts?.dayBuckets?.length;
    return rows.filter((r) => r.dayBucket !== null).map((r) => ({
      day: localMode ? String(r.dayBucket) : new Date(Number(r.dayBucket) * 86_400_000).toISOString().slice(0, 10),
      importKwh: r.importKwh === null ? null : Math.round(Number(r.importKwh) * 100) / 100,
      exportKwh: r.exportKwh === null ? null : Math.round(Number(r.exportKwh) * 100) / 100,
      maxDemandKw: r.maxDemand === null ? null : Math.round(Number(r.maxDemand) * 100) / 100,
      // #21: derived-from-active-power marker (no demand samples that day)
      demandDerived: Number(r.demandSamples ?? 0) === 0 && r.maxDemand !== null,
      counterReset: r.counterReset === true,
      avgPowerFactor: r.avgPf === null ? null : Math.round(Number(r.avgPf) * 1000) / 1000,
      samples: Number(r.samples),
    }));
  }

  // v8/D2: settlement energy intervals (same shape/semantics as the MySQL
  // store). Timescale keeps raw rows for the whole API window (31 d max vs the
  // 90 d retention policy), so a single raw query covers every range.
  async energyIntervals(meterId: number, from: Date, to: Date, bucketMin: number): Promise<EnergyIntervalBucket[]> {
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
