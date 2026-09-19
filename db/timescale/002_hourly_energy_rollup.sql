-- VoltTrade Cloud — TimescaleDB: hourly energy rollup for reports past the
-- raw-retention cutoff.
-- Target: TimescaleDB 2.x on PostgreSQL 16
-- Apply with: psql $TIMESCALE_URL -f db/timescale/002_hourly_energy_rollup.sql
--
-- WHY
-- 001_init.sql drops raw telemetry after 90 days, so on the Timescale store a
-- report older than that returned an EMPTY series while the same report on the
-- MySQL store returned data from telemetry_hourly. Reports are the product's
-- billing surface; silently returning nothing for last year is worse than
-- returning an approximation, and worse still is that the two stores disagreed.
--
-- The 001 `telemetry_hourly` aggregate could not close the gap: it carries
-- avg/max power and max(energy_import_kwh) only, and a maximum cannot express
-- a counter reset (a meter swap sets the register back to zero — max−min then
-- counts the whole pre-reset range a second time). This replaces it with the
-- first/last/min/max set the report math needs. The aggregate is derived data
-- and nothing queried the old shape, so dropping and recreating it is safe.
--
-- HOW the delta is reconstructed without a window function (continuous
-- aggregates permit aggregates only):
--   a monotonic counter inside one hour has first = min and last = max, so
--     reset inside the hour  ⇔  min < first  or  max > last
--   no reset  → delta = last − first
--   reset     → delta = (max − first) + (last − min)   [the two rising runs]
-- Inter-hour deltas (this hour's first minus the previous hour's last) are
-- added by the query layer with lag(), exactly as the MySQL store does.

drop materialized view if exists telemetry_hourly cascade;

create materialized view telemetry_hourly
with (timescaledb.continuous) as
select time_bucket('1 hour', ts)                  as hour_start,
       meter_id,
       count(*)                                   as samples,
       avg(active_power_kw)                       as avg_power_kw,
       max(active_power_kw)                       as max_power_kw,
       max(coalesce(demand_kw, active_power_kw))  as max_demand_kw,
       -- demand_samples = 0 → max_demand_kw was derived from active power and
       -- the UI must label it as such (#21, same contract as telemetry_daily).
       count(demand_kw)                           as demand_samples,
       avg(power_factor)                          as avg_power_factor,
       first(energy_import_kwh, ts)               as energy_import_first,
       last(energy_import_kwh, ts)                as energy_import_last,
       min(energy_import_kwh)                     as energy_import_min,
       max(energy_import_kwh)                     as energy_import_max,
       first(energy_export_kwh, ts)               as energy_export_first,
       last(energy_export_kwh, ts)                as energy_export_last,
       min(energy_export_kwh)                     as energy_export_min,
       max(energy_export_kwh)                     as energy_export_max
from telemetry
group by hour_start, meter_id
with no data;

select add_continuous_aggregate_policy('telemetry_hourly',
  start_offset => interval '1 day',
  end_offset   => interval '30 minutes',
  schedule_interval => interval '30 minutes',
  if_not_exists => true);

-- Reporting view: the delta/reset reconstruction above, so the application
-- SQL reads columns with the same names and meaning as the MySQL
-- telemetry_hourly table and the two report queries stay recognisably the same.
create or replace view telemetry_hourly_energy as
select hour_start,
       meter_id,
       samples,
       avg_power_kw,
       max_power_kw,
       max_demand_kw,
       demand_samples,
       avg_power_factor,
       energy_import_first,
       energy_import_last,
       energy_export_first,
       energy_export_last,
       case
         when energy_import_min < energy_import_first - 0.001
           or energy_import_max > energy_import_last + 0.001
           then (energy_import_max - energy_import_first) + (energy_import_last - energy_import_min)
         else energy_import_last - energy_import_first
       end as energy_import_delta_kwh,
       case
         when energy_export_min < energy_export_first - 0.001
           or energy_export_max > energy_export_last + 0.001
           then (energy_export_max - energy_export_first) + (energy_export_last - energy_export_min)
         else energy_export_last - energy_export_first
       end as energy_export_delta_kwh,
       (energy_import_min < energy_import_first - 0.001
        or energy_import_max > energy_import_last + 0.001
        or energy_export_min < energy_export_first - 0.001
        or energy_export_max > energy_export_last + 0.001) as counter_reset
from telemetry_hourly;

-- Backfill everything the raw retention still holds. Safe to re-run.
call refresh_continuous_aggregate('telemetry_hourly', null, null);
