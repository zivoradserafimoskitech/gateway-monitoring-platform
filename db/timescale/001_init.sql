-- Enertrek Cloud — TimescaleDB telemetry schema
-- Target: TimescaleDB 2.x on PostgreSQL 16
-- Apply with: psql $TIMESCALE_URL -f db/timescale/001_init.sql

create table if not exists telemetry (
  ts                   timestamptz      not null,
  meter_id             bigint           not null,
  voltage_l1           double precision,
  voltage_l2           double precision,
  voltage_l3           double precision,
  current_l1           double precision,
  current_l2           double precision,
  current_l3           double precision,
  active_power_kw      double precision,
  reactive_power_kvar  double precision,
  apparent_power_kva   double precision,
  power_factor         double precision,
  frequency_hz         double precision,
  energy_import_kwh    double precision,
  energy_export_kwh    double precision,
  demand_kw            double precision,
  raw                  jsonb
);

-- Hypertable: automatic partitioning by time (7-day chunks)
select create_hypertable('telemetry', 'ts', chunk_time_interval => interval '7 days', if_not_exists => true);

create index if not exists telemetry_meter_ts_idx on telemetry (meter_id, ts desc);

-- Native columnar compression, segmented per meter (~10x savings)
alter table telemetry set (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'meter_id',
  timescaledb.compress_orderby = 'ts desc'
);
select add_compression_policy('telemetry', compress_after => interval '7 days', if_not_exists => true);

-- Retention: raw samples kept 90 days; history lives on in daily rollups
select add_retention_policy('telemetry', drop_after => interval '90 days', if_not_exists => true);

-- Continuous aggregate: one row per meter per day — powers reports and
-- long-range trends in constant time regardless of raw volume.
create materialized view if not exists telemetry_daily
with (timescaledb.continuous) as
select time_bucket('1 day', ts)                 as day,
       meter_id,
       min(energy_import_kwh)                   as e_min,
       max(energy_import_kwh)                   as e_max,
       min(energy_export_kwh)                   as x_min,
       max(energy_export_kwh)                   as x_max,
       max(coalesce(demand_kw, active_power_kw)) as max_demand,
       avg(power_factor)                        as avg_pf,
       count(*)                                 as samples
from telemetry
group by day, meter_id
with no data;

select add_continuous_aggregate_policy('telemetry_daily',
  start_offset => interval '2 days',
  end_offset   => interval '1 hour',
  schedule_interval => interval '1 hour',
  if_not_exists => true);

-- Hourly rollup for fast long-range charts (optional but cheap)
create materialized view if not exists telemetry_hourly
with (timescaledb.continuous) as
select time_bucket('1 hour', ts) as hour,
       meter_id,
       avg(active_power_kw)      as avg_kw,
       max(active_power_kw)      as max_kw,
       avg(voltage_l1)           as avg_v1,
       avg(power_factor)         as avg_pf,
       max(energy_import_kwh)    as e_max,
       count(*)                  as samples
from telemetry
group by hour, meter_id
with no data;

select add_continuous_aggregate_policy('telemetry_hourly',
  start_offset => interval '1 day',
  end_offset   => interval '30 minutes',
  schedule_interval => interval '30 minutes',
  if_not_exists => true);
