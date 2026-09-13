-- VoltTrade Cloud — TimescaleDB: chart series in the hourly aggregate.
-- Target: TimescaleDB 2.x on PostgreSQL 16
-- Apply with: psql $TIMESCALE_URL -f db/timescale/003_hourly_chart_columns.sql
--
-- WHY
-- 002 gave the hourly aggregate everything a REPORT needs past the 90-day raw
-- retention, but not what a CHART needs: no voltage, current or frequency, and
-- no battery power or irradiance — the primary series for BESS and weather
-- devices (PRIMARY_POWER_KEY in contracts/devices.ts). A chart older than the
-- cutoff therefore came back empty while a report over the same week did not.
--
-- batteryPowerKw and irradianceWm2 live in values_json rather than in a
-- column. They are rolled up as fixed columns because the key set is bounded
-- and known — one primary key per device type — which keeps this a plain
-- continuous aggregate and keeps the MySQL and Timescale schemas symmetric.
--
-- Recreating the aggregate costs one refresh over whatever raw data the
-- retention policy still holds; it is derived data, so nothing is lost that
-- the raw rows can still produce.

drop materialized view if exists telemetry_hourly cascade;

create materialized view telemetry_hourly
with (timescaledb.continuous) as
select time_bucket('1 hour', ts)                  as hour_start,
       meter_id,
       count(*)                                   as samples,
       avg(active_power_kw)                       as avg_power_kw,
       max(active_power_kw)                       as max_power_kw,
       max(coalesce(demand_kw, active_power_kw))  as max_demand_kw,
       count(demand_kw)                           as demand_samples,
       avg(power_factor)                          as avg_power_factor,
       first(energy_import_kwh, ts)               as energy_import_first,
       last(energy_import_kwh, ts)                as energy_import_last,
       min(energy_import_kwh)                     as energy_import_min,
       max(energy_import_kwh)                     as energy_import_max,
       first(energy_export_kwh, ts)               as energy_export_first,
       last(energy_export_kwh, ts)                as energy_export_last,
       min(energy_export_kwh)                     as energy_export_min,
       max(energy_export_kwh)                     as energy_export_max,
       -- Chart series (this migration)
       avg(voltage_l1)                            as avg_voltage_l1,
       avg(current_l1)                            as avg_current_l1,
       avg(frequency_hz)                          as avg_frequency_hz,
       avg((values_json->>'batteryPowerKw')::double precision)  as avg_battery_power_kw,
       avg((values_json->>'irradianceWm2')::double precision)   as avg_irradiance_wm2
from telemetry
group by hour_start, meter_id
with no data;

select add_continuous_aggregate_policy('telemetry_hourly',
  start_offset => interval '1 day',
  end_offset   => interval '30 minutes',
  schedule_interval => interval '30 minutes',
  if_not_exists => true);

-- Reporting view: the delta/reset reconstruction from 002, unchanged, plus the
-- chart columns passed through. The application SQL reads the same column
-- names and meanings as the MySQL telemetry_hourly table.
create or replace view telemetry_hourly_energy as
select hour_start,
       meter_id,
       samples,
       avg_power_kw,
       max_power_kw,
       max_demand_kw,
       demand_samples,
       avg_power_factor,
       avg_voltage_l1,
       avg_current_l1,
       avg_frequency_hz,
       avg_battery_power_kw,
       avg_irradiance_wm2,
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
