// v7/C5: retention + downsampling for the MySQL telemetry store.
//
// Raw telemetry rows are kept for TELEMETRY_RAW_DAYS (default 90). A rollup
// job aggregates every closed hour into telemetry_hourly (counter-reset-safe
// energy deltas + first/last counters, like the C7 daily report), then a purge
// deletes the raw rows. Reports for days older than the cutoff read the hourly
// aggregates instead (see mysql-store.dailyReport).
//
// TimescaleDB deployments use native continuous aggregates + retention policies
// instead — this module is only wired up for the MySQL store (boot.ts).
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";

const RAW_DAYS = parseInt(process.env.TELEMETRY_RAW_DAYS || "90", 10);
const ROLLUP_INTERVAL_MIN = parseInt(process.env.ROLLUP_INTERVAL_MIN || "10", 10);

const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** Raw rows older than this are rolled up + purged. */
export function retentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - RAW_DAYS * 86_400_000);
}

/**
 * Aggregate one UTC hour [hourStart, +1h) for all meters; idempotent upsert.
 * Note: FALSE OR NULL = NULL in MySQL, hence the coalesce on counter_reset —
 * hours whose rows carry no energy counters would otherwise insert NULL into
 * the NOT NULL column.
 */
export async function rollupHour(hourStartUtc: Date): Promise<number> {
  const db = getDb();
  const h0 = new Date(Math.floor(hourStartUtc.getTime() / 3_600_000) * 3_600_000);
  const h1 = new Date(h0.getTime() + 3_600_000);
  const res = await db.execute(sql`
    insert into telemetry_hourly
      (meter_id, hour_start, samples, avg_power_kw, max_power_kw, max_demand_kw,
       demand_samples, avg_power_factor,
       energy_import_delta_kwh, energy_export_delta_kwh,
       energy_import_first, energy_import_last,
       energy_export_first, energy_export_last, counter_reset)
    with ordered as (
      select
        meter_id,
        energy_import_kwh as e,
        energy_export_kwh as x,
        lag(energy_import_kwh) over (partition by meter_id order by ts) as e_prev,
        lag(energy_export_kwh) over (partition by meter_id order by ts) as x_prev,
        active_power_kw as p,
        demand_kw as d,
        power_factor as pf,
        first_value(energy_import_kwh) over (partition by meter_id order by ts) as e_first,
        last_value(energy_import_kwh) over (
          partition by meter_id order by ts
          rows between unbounded preceding and unbounded following) as e_last,
        first_value(energy_export_kwh) over (partition by meter_id order by ts) as x_first,
        last_value(energy_export_kwh) over (
          partition by meter_id order by ts
          rows between unbounded preceding and unbounded following) as x_last
      from telemetry
      where ts >= ${utcStr(h0)} and ts < ${utcStr(h1)}
    )
    select
      meter_id,
      ${utcStr(h0)} as hour_start,
      count(*) as samples,
      avg(p) as avg_power_kw,
      max(p) as max_power_kw,
      max(coalesce(d, p)) as max_demand_kw,
      count(d) as demand_samples,
      avg(pf) as avg_power_factor,
      sum(greatest(e - e_prev, 0)) as energy_import_delta_kwh,
      sum(greatest(x - x_prev, 0)) as energy_export_delta_kwh,
      max(e_first) as energy_import_first,
      max(e_last) as energy_import_last,
      max(x_first) as energy_export_first,
      max(x_last) as energy_export_last,
      coalesce(max(e - e_prev < -0.001 or x - x_prev < -0.001), 0) as counter_reset
    from ordered
    group by meter_id
    on duplicate key update
      samples = values(samples),
      avg_power_kw = values(avg_power_kw),
      max_power_kw = values(max_power_kw),
      max_demand_kw = values(max_demand_kw),
      demand_samples = values(demand_samples),
      avg_power_factor = values(avg_power_factor),
      energy_import_delta_kwh = values(energy_import_delta_kwh),
      energy_export_delta_kwh = values(energy_export_delta_kwh),
      energy_import_first = values(energy_import_first),
      energy_import_last = values(energy_import_last),
      energy_export_first = values(energy_export_first),
      energy_export_last = values(energy_export_last),
      counter_reset = values(counter_reset)`);
  const affected = Number((res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
  // upsert counts an update as 2 — good enough for logging
  return affected;
}

/** Roll up every hour touched by [fromUtc, toUtc). Returns hours processed. */
export async function rollupRange(fromUtc: Date, toUtc: Date): Promise<number> {
  let h = new Date(Math.floor(fromUtc.getTime() / 3_600_000) * 3_600_000);
  let hours = 0;
  while (h.getTime() < toUtc.getTime()) {
    await rollupHour(h);
    hours++;
    h = new Date(h.getTime() + 3_600_000);
  }
  return hours;
}

/**
 * Roll up all raw data older than cutoffUtc, then delete those raw rows.
 * Destructive — refuses to run against a non-local DB without
 * ALLOW_UNSAFE_PROD=1 (session rule for destructive scripts).
 */
export async function purgeRaw(cutoffUtc: Date): Promise<{ rolledHours: number; deleted: number }> {
  const url = process.env.DATABASE_URL ?? "";
  const local = /localhost|127\.0\.0\.1/.test(url);
  if (!local && process.env.ALLOW_UNSAFE_PROD !== "1") {
    throw new Error("purgeRaw refuses to run against a remote DB without ALLOW_UNSAFE_PROD=1");
  }
  const db = getDb();
  // Oldest raw ts before the cutoff → roll up the full [oldest, cutoff) span.
  // Read as epoch: mysql2 parses naive datetimes in the NODE process TZ (+8h
  // here), which would shift the rollup window — unix_timestamp is session-UTC.
  const rows = await db.execute(sql`
    select unix_timestamp(min(ts)) as oldest_epoch from telemetry where ts < ${utcStr(cutoffUtc)}`);
  const oldestEpoch = (rows as unknown as [Record<string, unknown>[]])[0][0]?.oldest_epoch;
  let rolledHours = 0;
  if (oldestEpoch !== null && oldestEpoch !== undefined) {
    rolledHours = await rollupRange(new Date(Number(oldestEpoch) * 1000), cutoffUtc);
  }
  const del = await db.execute(sql`delete from telemetry where ts < ${utcStr(cutoffUtc)}`);
  const deleted = Number((del as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
  return { rolledHours, deleted };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Periodic job: every ROLLUP_INTERVAL_MIN, roll up the last fully closed hour;
 * once per invocation also purge raw rows past the retention cutoff (purge is
 * cheap when there's nothing to do). Unref'd — never keeps the process alive.
 */
export function startRetentionLoop(): void {
  if (timer) return;
  const tick = async () => {
    try {
      const now = Date.now();
      const lastClosedHour = new Date(Math.floor(now / 3_600_000) * 3_600_000 - 3_600_000);
      await rollupHour(lastClosedHour);
      const cutoff = retentionCutoff();
      const { rolledHours, deleted } = await purgeRaw(cutoff);
      if (deleted > 0) {
        console.log(`[retention] purged ${deleted} raw rows older than ${cutoff.toISOString()} (${rolledHours} hours rolled up)`);
      }
    } catch (err) {
      console.error("[retention] tick failed:", err instanceof Error ? err.message : err);
    }
  };
  timer = setInterval(() => void tick(), ROLLUP_INTERVAL_MIN * 60_000);
  timer.unref?.();
  // Run once at boot so a restart immediately backfills/purges.
  void tick();
}
