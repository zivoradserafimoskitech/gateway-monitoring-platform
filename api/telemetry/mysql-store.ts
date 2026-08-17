// MySQL telemetry store — keeps telemetry in the same database as metadata.
// Suitable for small fleets (dev, pilots, up to ~50 gateways at 1 min reporting).
// For 300–500 gateways use the TimescaleDB store.
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb, createWriteDb } from "../queries/connection";
import { telemetry } from "@db/schema";
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
import { env } from "../lib/env";
import { COLUMN_BACKED_METRICS, assertValidMetricKeys } from "./types";
import { retentionCutoff } from "./rollup";

// v7/C5: merge raw-range and hourly-range report rows per day (ranges that
// straddle the retention cutoff). pf is samples-weighted; energies sum.
function mergeDayRows(parts: DailyReportRow[][]): DailyReportRow[] {
  const map = new Map<string, DailyReportRow>();
  const sumN = (a: number | null, b: number | null) =>
    a === null ? b : b === null ? a : Math.round((a + b) * 100) / 100;
  for (const rows of parts) {
    for (const r of rows) {
      const ex = map.get(r.day);
      if (!ex) {
        map.set(r.day, { ...r });
        continue;
      }
      const totSamples = ex.samples + r.samples;
      ex.avgPowerFactor =
        ex.avgPowerFactor === null
          ? r.avgPowerFactor
          : r.avgPowerFactor === null
            ? ex.avgPowerFactor
            : Math.round(((ex.avgPowerFactor * ex.samples + r.avgPowerFactor * r.samples) / totSamples) * 1000) / 1000;
      ex.importKwh = sumN(ex.importKwh, r.importKwh);
      ex.exportKwh = sumN(ex.exportKwh, r.exportKwh);
      ex.maxDemandKw =
        ex.maxDemandKw === null ? r.maxDemandKw
          : r.maxDemandKw === null ? ex.maxDemandKw
            : Math.max(ex.maxDemandKw, r.maxDemandKw);
      ex.demandDerived = ex.demandDerived && r.demandDerived;
      ex.counterReset = ex.counterReset || r.counterReset;
      ex.samples = totSamples;
    }
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

type WriteDb = ReturnType<typeof createWriteDb>;
let writeDb: WriteDb | null = null;

// The batched hot path gets its OWN small connection pool, so bursts of
// metadata work (auto-provisioning, UI queries) can never starve telemetry
// writes of connections.
function getWriteDb(): WriteDb {
  if (!writeDb) {
    // createWriteDb pins UTC on driver + session (see api/queries/connection.ts).
    writeDb = createWriteDb({ connectionLimit: 4, enableKeepAlive: true });
  }
  return writeDb;
}

export class MySqlTelemetryStore implements TelemetryStore {
  async writeBatch(rows: TelemetryRow[]): Promise<void> {
    if (rows.length === 0) return;
    const db = getWriteDb();
    await db.insert(telemetry).values(
      rows.map((r) => ({
        meterId: r.meterId,
        ts: r.ts,
        voltageL1: r.values.voltageL1 ?? null,
        voltageL2: r.values.voltageL2 ?? null,
        voltageL3: r.values.voltageL3 ?? null,
        currentL1: r.values.currentL1 ?? null,
        currentL2: r.values.currentL2 ?? null,
        currentL3: r.values.currentL3 ?? null,
        activePowerKw: r.values.activePowerKw ?? null,
        reactivePowerKvar: r.values.reactivePowerKvar ?? null,
        apparentPowerKva: r.values.apparentPowerKva ?? null,
        powerFactor: r.values.powerFactor ?? null,
        frequencyHz: r.values.frequencyHz ?? null,
        energyImportKwh: r.values.energyImportKwh ?? null,
        energyExportKwh: r.values.energyExportKwh ?? null,
        demandKw: r.values.demandKw ?? null,
        valuesJson: r.values,
        raw: (r.raw ?? null) as Record<string, unknown> | null,
      })),
    );
  }

  async latest(meterId: number): Promise<TelemetryRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(telemetry)
      .where(eq(telemetry.meterId, meterId))
      .orderBy(desc(telemetry.ts))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    // Fixed columns give the 14 meter metrics; values_json carries the full
    // open key map (inverter/BESS/weather registers). JSON wins on conflicts
    // so corrected decodes propagate.
    const values: Record<string, number> = {
      ...(r.voltageL1 !== null ? { voltageL1: r.voltageL1 } : {}),
      ...(r.voltageL2 !== null ? { voltageL2: r.voltageL2 } : {}),
      ...(r.voltageL3 !== null ? { voltageL3: r.voltageL3 } : {}),
      ...(r.currentL1 !== null ? { currentL1: r.currentL1 } : {}),
      ...(r.currentL2 !== null ? { currentL2: r.currentL2 } : {}),
      ...(r.currentL3 !== null ? { currentL3: r.currentL3 } : {}),
      ...(r.activePowerKw !== null ? { activePowerKw: r.activePowerKw } : {}),
      ...(r.reactivePowerKvar !== null ? { reactivePowerKvar: r.reactivePowerKvar } : {}),
      ...(r.apparentPowerKva !== null ? { apparentPowerKva: r.apparentPowerKva } : {}),
      ...(r.powerFactor !== null ? { powerFactor: r.powerFactor } : {}),
      ...(r.frequencyHz !== null ? { frequencyHz: r.frequencyHz } : {}),
      ...(r.energyImportKwh !== null ? { energyImportKwh: r.energyImportKwh } : {}),
      ...(r.energyExportKwh !== null ? { energyExportKwh: r.energyExportKwh } : {}),
      ...(r.demandKw !== null ? { demandKw: r.demandKw } : {}),
      ...((typeof r.valuesJson === "string" ? JSON.parse(r.valuesJson) : (r.valuesJson ?? {})) as Record<string, number>),
    };
    return { meterId: r.meterId, ts: r.ts, values };
  }

  // audit wave 6: age-bounded read for EMS control decisions. One query (the
  // same one as latest()), age measured against the APP clock. Safe because
  // telemetry.ts is always written app-side (persistTelemetry: new Date();
  // the column's defaultNow() never fires on the ingest path) and the write
  // pool pins UTC on driver + session — verified against the dev TiDB:
  // naive-UTC MAX(ts) tracks the app clock, not the shifted server clock.
  async freshForControl(meterId: number, maxAgeMs: number = env.controlTelemetryMaxAgeMs): Promise<FreshTelemetry> {
    const row = await this.latest(meterId);
    if (!row) return { row: null, fresh: false, ageMs: null };
    const ageMs = Date.now() - row.ts.getTime();
    return { row, fresh: ageMs <= maxAgeMs, ageMs };
  }

  async latestAll(): Promise<Map<number, TelemetryRow>> {
    const db = getDb();
    // Set-based "latest per meter": the GROUP BY uses a loose index scan on
    // (meter_id, ts), the join fetches one row per meter — scales to millions.
    const res = await db.execute(sql`
      select t.meter_id, t.ts, t.active_power_kw, t.energy_import_kwh, t.values_json
      from telemetry t
      inner join (
        select meter_id, max(ts) as mx from telemetry group by meter_id
      ) x on x.meter_id = t.meter_id and x.mx = t.ts
    `);
    const map = new Map<number, TelemetryRow>();
    for (const row of res[0] as unknown as Array<Record<string, unknown>>) {
      const meterId = Number(row.meter_id);
      const rawJson = row.values_json;
      const json = (typeof rawJson === "string" ? JSON.parse(rawJson) : (rawJson ?? {})) as Record<string, number>;
      map.set(meterId, {
        meterId,
        ts: new Date(row.ts as string),
        values: {
          ...json,
          activePowerKw: row.active_power_kw === null ? json.activePowerKw : Number(row.active_power_kw),
          energyImportKwh: row.energy_import_kwh === null ? json.energyImportKwh : Number(row.energy_import_kwh),
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
    const db = getDb();
    // #20: the chart series follows the device's PRIMARY_POWER_KEY. Non-column
    // keys (e.g. BESS batteryPowerKw) are averaged out of values_json.
    const key = powerKey && /^[A-Za-z0-9_]+$/.test(powerKey) ? powerKey : "activePowerKw";
    const powerExpr =
      key === "activePowerKw"
        ? sql<number>`avg(${telemetry.activePowerKw})`
        : sql<number>`avg(cast(json_unquote(json_extract(${telemetry.valuesJson}, ${"$." + key})) as decimal(24,6)))`;
    const rows = await db
      .select({
        bucket: sql<number>`floor(unix_timestamp(${telemetry.ts}) / ${bucketSec}) * ${bucketSec}`.as("bucket"),
        powerKw: powerExpr.as("powerKw"),
        activePowerKw: sql<number>`avg(${telemetry.activePowerKw})`.as("activePowerKw"),
        voltageL1: sql<number>`avg(${telemetry.voltageL1})`.as("voltageL1"),
        currentL1: sql<number>`avg(${telemetry.currentL1})`.as("currentL1"),
        powerFactor: sql<number>`avg(${telemetry.powerFactor})`.as("powerFactor"),
        frequencyHz: sql<number>`avg(${telemetry.frequencyHz})`.as("frequencyHz"),
        energyImportKwh: sql<number>`max(${telemetry.energyImportKwh})`.as("energyImportKwh"),
        samples: sql<number>`count(*)`.as("samples"),
      })
      .from(telemetry)
      .where(and(eq(telemetry.meterId, meterId), gte(telemetry.ts, from), lte(telemetry.ts, to)))
      .groupBy(sql`bucket`)
      .orderBy(sql`bucket`);
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
    const db = getDb();
    const rows = await db
      .select({
        bucket: sql<number>`floor(unix_timestamp(${telemetry.ts}) / ${bucketSec}) * ${bucketSec}`.as("bucket"),
        meterId: telemetry.meterId,
        avgKw: sql<number>`avg(${telemetry.activePowerKw})`.as("avgKw"),
      })
      .from(telemetry)
      .where(gte(telemetry.ts, from))
      .groupBy(sql`bucket`, telemetry.meterId)
      .orderBy(sql`bucket`);
    return rows.map((r) => ({
      bucketSec: Number(r.bucket),
      meterId: r.meterId,
      avgKw: r.avgKw === null ? null : Number(r.avgKw),
    }));
  }

  async firstEnergySince(meterId: number, from: Date): Promise<number | null> {
    const db = getDb();
    const rows = await db
      .select({ v: telemetry.energyImportKwh })
      .from(telemetry)
      .where(and(eq(telemetry.meterId, meterId), gte(telemetry.ts, from)))
      .orderBy(telemetry.ts)
      .limit(1);
    return rows[0]?.v ?? null;
  }

  async firstEnergyAll(since: Date): Promise<Map<number, number>> {
    const db = getDb();
    // #13: the energy counter key differs per device type — meters use the
    // energy_import_kwh column, inverters/BESS keep their counters
    // (energyTotalKwh / dischargeEnergyTotalKwh) in values_json.
    const res = await db.execute(sql`
      select t.meter_id,
        coalesce(
          t.energy_import_kwh,
          cast(json_unquote(json_extract(t.values_json, '$.energyTotalKwh')) as decimal(24,6)),
          cast(json_unquote(json_extract(t.values_json, '$.dischargeEnergyTotalKwh')) as decimal(24,6))
        ) as e
      from telemetry t
      inner join (
        select meter_id, min(ts) as mn from telemetry where ts >= ${since} group by meter_id
      ) x on x.meter_id = t.meter_id and x.mn = t.ts
    `);
    const map = new Map<number, number>();
    for (const row of res[0] as unknown as Array<Record<string, unknown>>) {
      if (row.e !== null && row.e !== undefined) map.set(Number(row.meter_id), Number(row.e));
    }
    return map;
  }

  // v7/C5: days older than the retention cutoff are read from telemetry_hourly
  // (raw rows are purged); newer days come from raw rows. Ranges straddling the
  // cutoff are split and merged per day.
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

  private async dailyReportRaw(meterId: number, from: Date, to: Date, opts?: DailyReportOpts): Promise<DailyReportRow[]> {
    const db = getDb();
    // v7/C8 fix: raw sql`` Date params are serialized by mysql2 in the NODE
    // process timezone (e.g. Asia/Shanghai +8), while drizzle column inserts
    // store naive UTC — the mismatch shifted every boundary. Pass Dates as
    // explicit naive-UTC strings so comparisons match the stored values.
    const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    // v7/C8: site-local day buckets (DST-correct UTC ranges computed in JS) —
    // grouped via a CASE expression; default remains UTC-midnight epoch buckets.
    const bucketExpr = opts?.dayBuckets?.length
      ? sql.join(
          [
            sql`case `,
            sql.join(
              opts.dayBuckets.map(
                (b) => sql`when ts >= ${utcStr(b.startUtc)} and ts < ${utcStr(b.endUtc)} then ${b.label} `,
              ),
              sql` `,
            ),
            sql`else null end`,
          ],
          sql``,
        )
      : sql`floor(unix_timestamp(ts) / 86400)`;
    // #8: day buckets by epoch — floor(unix_timestamp/86400) is a UTC calendar
    // day, independent of the server/session timezone (the old date_format()
    // grouping followed the server TZ and disagreed with the browser).
    // v7/C7: energy per day = sum of NON-NEGATIVE counter deltas (window
    // function), not max−min — a counter reset/meter swap inside the day used
    // to explode the total (max−min counts the whole pre-reset range again).
    // Days with a detected decrease are flagged counterReset for the UI.
    const res = await db.execute(sql`
      with ordered as (
        select
          ${telemetry.ts} as ts,
          ${telemetry.energyImportKwh} as e,
          ${telemetry.energyExportKwh} as x,
          lag(${telemetry.energyImportKwh}) over (order by ${telemetry.ts}) as e_prev,
          lag(${telemetry.energyExportKwh}) over (order by ${telemetry.ts}) as x_prev,
          coalesce(${telemetry.demandKw}, ${telemetry.activePowerKw}) as demand,
          ${telemetry.demandKw} as demand_raw,
          ${telemetry.powerFactor} as pf
        from ${telemetry}
        where ${telemetry.meterId} = ${meterId}
          and ${telemetry.ts} >= ${utcStr(from)}
          and ${telemetry.ts} <= ${utcStr(to)}
      )
      select
        ${bucketExpr} as dayBucket,
        sum(greatest(e - e_prev, 0)) as importKwh,
        sum(greatest(x - x_prev, 0)) as exportKwh,
        max(e - e_prev < -0.001 or x - x_prev < -0.001) as counterReset,
        max(demand) as maxDemand,
        count(demand_raw) as demandSamples,
        avg(pf) as avgPf,
        count(*) as samples
      from ordered
      group by dayBucket
      order by dayBucket`);
    const rows = (res as unknown as [Record<string, unknown>[]])[0];
    const localMode = !!opts?.dayBuckets?.length;
    return rows.filter((r) => r.dayBucket !== null).map((r) => ({
      // v7/C8: in local mode the bucket IS the local-day label; otherwise the
      // numeric UTC epoch bucket renders the day in JS (session-TZ-proof, #8).
      day: localMode
        ? String(r.dayBucket)
        : new Date(Number(r.dayBucket) * 86_400_000).toISOString().slice(0, 10),
      importKwh: r.importKwh === null ? null : Math.round(Number(r.importKwh) * 100) / 100,
      exportKwh: r.exportKwh === null ? null : Math.round(Number(r.exportKwh) * 100) / 100,
      maxDemandKw: r.maxDemand === null ? null : Math.round(Number(r.maxDemand) * 100) / 100,
      // #21: no demand register samples that day → maxDemand was derived from
      // active power and must be labeled as such.
      demandDerived: Number(r.demandSamples) === 0 && r.maxDemand !== null,
      counterReset: Number(r.counterReset) === 1,
      avgPowerFactor: r.avgPf === null ? null : Math.round(Number(r.avgPf) * 1000) / 1000,
      samples: Number(r.samples),
    }));
  }

  // v7/C5: same report shape, computed from hourly aggregates. Energy per day =
  // sum of stored intra-hour non-negative deltas PLUS inter-hour deltas between
  // each hour's first counter and the previous hour's last (lag), so counter
  // resets stay safe exactly like the raw C7 query.
  private async dailyReportFromHourly(
    meterId: number,
    from: Date,
    to: Date,
    opts?: DailyReportOpts,
  ): Promise<DailyReportRow[]> {
    const db = getDb();
    const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const bucketExpr = opts?.dayBuckets?.length
      ? sql.join(
          [
            sql`case `,
            sql.join(
              opts.dayBuckets.map(
                (b) => sql`when ts >= ${utcStr(b.startUtc)} and ts < ${utcStr(b.endUtc)} then ${b.label} `,
              ),
              sql` `,
            ),
            sql`else null end`,
          ],
          sql``,
        )
      : sql`floor(unix_timestamp(ts) / 86400)`;
    const res = await db.execute(sql`
      with ordered as (
        select
          hour_start as ts,
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
        from telemetry_hourly
        where meter_id = ${meterId}
          and hour_start >= ${utcStr(from)}
          and hour_start <= ${utcStr(to)}
      )
      select
        ${bucketExpr} as dayBucket,
        sum(coalesce(e_intra, 0) + greatest(coalesce(e_first - e_prev_last, 0), 0)) as importKwh,
        sum(coalesce(x_intra, 0) + greatest(coalesce(x_first - x_prev_last, 0), 0)) as exportKwh,
        coalesce(max(cr = 1 or e_first - e_prev_last < -0.001 or x_first - x_prev_last < -0.001), 0) as counterReset,
        max(demand) as maxDemand,
        sum(demand_n) as demandSamples,
        sum(pf * samples) / nullif(sum(samples), 0) as avgPf,
        sum(samples) as samples
      from ordered
      group by dayBucket
      order by dayBucket`);
    const rows = (res as unknown as [Record<string, unknown>[]])[0];
    const localMode = !!opts?.dayBuckets?.length;
    return rows.filter((r) => r.dayBucket !== null).map((r) => ({
      day: localMode
        ? String(r.dayBucket)
        : new Date(Number(r.dayBucket) * 86_400_000).toISOString().slice(0, 10),
      importKwh: r.importKwh === null ? null : Math.round(Number(r.importKwh) * 100) / 100,
      exportKwh: r.exportKwh === null ? null : Math.round(Number(r.exportKwh) * 100) / 100,
      maxDemandKw: r.maxDemand === null ? null : Math.round(Number(r.maxDemand) * 100) / 100,
      demandDerived: Number(r.demandSamples) === 0 && r.maxDemand !== null,
      counterReset: Number(r.counterReset) === 1,
      avgPowerFactor: r.avgPf === null ? null : Math.round(Number(r.avgPf) * 1000) / 1000,
      samples: Number(r.samples),
    }));
  }

  // v8/D2: settlement energy intervals for the public REST API. Recent range
  // is bucketed from raw rows (same C7 non-negative-delta window function as
  // dailyReportRaw); range older than the retention cutoff comes from
  // telemetry_hourly (sub-hour buckets are expanded evenly and marked
  // estimated). Counter keys verified against stored data: fixed columns
  // energy_import_kwh/energy_export_kwh (meters), with a values_json fallback
  // for paths that only persist the open key map.
  async energyIntervals(meterId: number, from: Date, to: Date, bucketMin: number): Promise<EnergyIntervalBucket[]> {
    const cutoff = retentionCutoff();
    const parts: EnergyIntervalBucket[][] = [];
    if (from < cutoff) {
      parts.push(await this.energyIntervalsHourly(meterId, from, to < cutoff ? to : cutoff, bucketMin));
    }
    if (to >= cutoff) {
      parts.push(await this.energyIntervalsRaw(meterId, from > cutoff ? from : cutoff, to, bucketMin));
    }
    // A bucket can straddle the cutoff (partial hourly + partial raw) — merge.
    const byBucket = new Map<number, EnergyIntervalBucket>();
    for (const b of parts.flat()) {
      const ex = byBucket.get(b.bucketStartSec);
      if (!ex) {
        byBucket.set(b.bucketStartSec, { ...b });
        continue;
      }
      const totSamples = ex.samples + b.samples;
      ex.avgPowerKw =
        ex.avgPowerKw === null
          ? b.avgPowerKw
          : b.avgPowerKw === null
            ? ex.avgPowerKw
            : Math.round(((ex.avgPowerKw * ex.samples + b.avgPowerKw * b.samples) / totSamples) * 1000) / 1000;
      ex.importKwh = ex.importKwh === null ? b.importKwh : b.importKwh === null ? ex.importKwh : Math.round((ex.importKwh + b.importKwh) * 1000) / 1000;
      ex.exportKwh = ex.exportKwh === null ? b.exportKwh : b.exportKwh === null ? ex.exportKwh : Math.round((ex.exportKwh + b.exportKwh) * 1000) / 1000;
      ex.samples = totSamples;
      ex.estimated = ex.estimated || b.estimated;
    }
    return [...byBucket.values()].sort((a, b) => a.bucketStartSec - b.bucketStartSec);
  }

  private async energyIntervalsRaw(meterId: number, from: Date, to: Date, bucketMin: number): Promise<EnergyIntervalBucket[]> {
    const db = getDb();
    const bucketSec = bucketMin * 60;
    const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    // Same counter-reset-safe semantics as dailyReportRaw (v7/C7): per-sample
    // non-negative deltas via lag(); a decrease flags the bucket estimated.
    const res = await db.execute(sql`
      with ordered as (
        select
          ${telemetry.ts} as ts,
          coalesce(${telemetry.energyImportKwh}, cast(values_json->>'$.energyImportKwh' as double)) as e,
          coalesce(${telemetry.energyExportKwh}, cast(values_json->>'$.energyExportKwh' as double)) as x,
          lag(coalesce(${telemetry.energyImportKwh}, cast(values_json->>'$.energyImportKwh' as double))) over (order by ${telemetry.ts}) as e_prev,
          lag(coalesce(${telemetry.energyExportKwh}, cast(values_json->>'$.energyExportKwh' as double))) over (order by ${telemetry.ts}) as x_prev,
          coalesce(${telemetry.activePowerKw}, cast(values_json->>'$.activePowerKw' as double)) as p
        from ${telemetry}
        where ${telemetry.meterId} = ${meterId}
          and ${telemetry.ts} >= ${utcStr(from)}
          and ${telemetry.ts} <= ${utcStr(to)}
      )
      select
        floor(unix_timestamp(ts) / ${bucketSec}) as b,
        sum(greatest(e - e_prev, 0)) as importKwh,
        sum(greatest(x - x_prev, 0)) as exportKwh,
        coalesce(max(e - e_prev < -0.001 or x - x_prev < -0.001), 0) as counterReset,
        avg(p) as avgPower,
        count(*) as samples
      from ordered
      group by b
      order by b`);
    const rows = (res as unknown as [Record<string, unknown>[]])[0];
    return rows.map((r) => ({
      bucketStartSec: Number(r.b) * bucketSec,
      importKwh: r.importKwh === null ? null : Math.round(Number(r.importKwh) * 1000) / 1000,
      exportKwh: r.exportKwh === null ? null : Math.round(Number(r.exportKwh) * 1000) / 1000,
      avgPowerKw: r.avgPower === null ? null : Math.round(Number(r.avgPower) * 1000) / 1000,
      samples: Number(r.samples),
      estimated: Number(r.counterReset) === 1,
    }));
  }

  private async energyIntervalsHourly(meterId: number, from: Date, to: Date, bucketMin: number): Promise<EnergyIntervalBucket[]> {
    const db = getDb();
    const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const hourFloor = new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000);
    if (bucketMin >= 60) {
      // Same rollup math as dailyReportFromHourly: intra-hour stored deltas
      // plus inter-hour first−prev-last, grouped into the wider buckets.
      const bucketSec = bucketMin * 60;
      const res = await db.execute(sql`
        with ordered as (
          select
            hour_start as ts,
            energy_import_delta_kwh as e_intra,
            energy_export_delta_kwh as x_intra,
            energy_import_first as e_first,
            energy_export_first as x_first,
            lag(energy_import_last) over (order by hour_start) as e_prev_last,
            lag(energy_export_last) over (order by hour_start) as x_prev_last,
            avg_power_kw as p,
            samples,
            counter_reset as cr
          from telemetry_hourly
          where meter_id = ${meterId}
            and hour_start >= ${utcStr(hourFloor)}
            and hour_start < ${utcStr(to)}
        )
        select
          floor(unix_timestamp(ts) / ${bucketSec}) as b,
          sum(coalesce(e_intra, 0) + greatest(coalesce(e_first - e_prev_last, 0), 0)) as importKwh,
          sum(coalesce(x_intra, 0) + greatest(coalesce(x_first - x_prev_last, 0), 0)) as exportKwh,
          coalesce(max(cr = 1 or e_first - e_prev_last < -0.001 or x_first - x_prev_last < -0.001), 0) as counterReset,
          sum(p * samples) / nullif(sum(samples), 0) as avgPower,
          sum(samples) as samples
        from ordered
        group by b
        order by b`);
      const rows = (res as unknown as [Record<string, unknown>[]])[0];
      return rows.map((r) => ({
        bucketStartSec: Number(r.b) * bucketSec,
        importKwh: r.importKwh === null ? null : Math.round(Number(r.importKwh) * 1000) / 1000,
        exportKwh: r.exportKwh === null ? null : Math.round(Number(r.exportKwh) * 1000) / 1000,
        avgPowerKw: r.avgPower === null ? null : Math.round(Number(r.avgPower) * 1000) / 1000,
        samples: Number(r.samples),
        estimated: Number(r.counterReset) === 1,
      }));
    }
    // bucketMin < 60 over the hourly range: expand each hour evenly into its
    // sub-buckets — resolution was destroyed by the rollup, hence estimated.
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

  // audit wave 4 (Task 4): multi-metric bucketed series for the public REST
  // API. Keys are validated against METRIC_KEY_RE BEFORE any interpolation —
  // they are identifiers, not bind values, so the whitelist IS the injection
  // defence (the REST layer validates too; this is defence in depth).
  // Column-backed keys AVG the real indexed column; everything else is
  // extracted from values_json. Only non-empty buckets are returned — the
  // REST layer materializes the full grid (same split as energyIntervals).
  async metricSeries(meterId: number, from: Date, to: Date, bucketSec: number, keys: string[]): Promise<MetricSeriesBucket[]> {
    assertValidMetricKeys(keys);
    if (!Number.isInteger(bucketSec) || bucketSec <= 0) throw new Error("bucketSec must be a positive integer");
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const db = getDb();
    // Raw-sql Date params follow the node process TZ; pass explicit naive-UTC
    // strings (same fix as dailyReportRaw, v7/C8).
    const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const avgExprs = unique.map((k) => {
      const col = COLUMN_BACKED_METRICS[k];
      const expr = col
        ? sql`avg(${sql.raw(col)})`
        : sql`avg(cast(json_unquote(json_extract(values_json, ${`$."${k}"`})) as double))`;
      return sql`${expr} as ${sql.raw(`\`${k}\``)}`;
    });
    const res = await db.execute(sql`
      select floor(unix_timestamp(ts) / ${bucketSec}) as b, count(*) as samples, ${sql.join(avgExprs, sql`, `)}
      from telemetry
      where meter_id = ${meterId}
        and ts >= ${utcStr(from)}
        and ts <= ${utcStr(to)}
      group by b
      order by b`);
    const rows = (res as unknown as [Record<string, unknown>[]])[0];
    return rows.map((r) => ({
      bucketStartSec: Number(r.b) * bucketSec,
      values: Object.fromEntries(unique.map((k) => [k, r[k] == null ? null : Number(r[k])])),
      samples: Number(r.samples),
    }));
  }

  async close(): Promise<void> {
    // MySQL pool lifecycle is owned by api/queries/connection
  }
}
