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
  DailyReportRow,
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
      },
    };
  }

  async latestAll(): Promise<Map<number, TelemetryRow>> {
    // DISTINCT ON + the (meter_id, ts desc) index = one index row per meter
    const { rows } = await this.pool.query(
      `select distinct on (meter_id) meter_id, ts, active_power_kw, energy_import_kwh
       from telemetry order by meter_id, ts desc`,
    );
    const map = new Map<number, TelemetryRow>();
    for (const r of rows) {
      map.set(r.meter_id, {
        meterId: r.meter_id,
        ts: r.ts,
        values: {
          activePowerKw: r.active_power_kw ?? undefined,
          energyImportKwh: r.energy_import_kwh ?? undefined,
        },
      });
    }
    return map;
  }

  async history(meterId: number, from: Date, to: Date, bucketSec: number): Promise<HistoryPoint[]> {
    const { rows } = await this.pool.query(
      `select (extract(epoch from time_bucket($4 * interval '1 second', ts)))::bigint as bucket,
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
    const { rows } = await this.pool.query(
      `select distinct on (meter_id) meter_id, energy_import_kwh
       from telemetry where ts >= $1 and energy_import_kwh is not null
       order by meter_id, ts asc`,
      [since],
    );
    const map = new Map<number, number>();
    for (const r of rows) map.set(r.meter_id, Number(r.energy_import_kwh));
    return map;
  }

  async dailyReport(meterId: number, from: Date, to: Date): Promise<DailyReportRow[]> {
    // Served by the continuous aggregate — constant-time regardless of raw volume.
    const { rows } = await this.pool.query(
      `select to_char(day, 'YYYY-MM-DD') as day,
              e_min, e_max, x_min, x_max, max_demand, avg_pf, samples
       from telemetry_daily
       where meter_id = $1 and day >= $2::timestamptz and day <= $3::timestamptz
       order by day`,
      [meterId, from, to],
    );
    return rows.map((r) => ({
      day: r.day,
      importKwh:
        r.e_min === null || r.e_max === null ? null : Math.round((Number(r.e_max) - Number(r.e_min)) * 100) / 100,
      exportKwh:
        r.x_min === null || r.x_max === null ? null : Math.round((Number(r.x_max) - Number(r.x_min)) * 100) / 100,
      maxDemandKw: r.max_demand === null ? null : Math.round(Number(r.max_demand) * 100) / 100,
      avgPowerFactor: r.avg_pf === null ? null : Math.round(Number(r.avg_pf) * 1000) / 1000,
      samples: Number(r.samples),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
