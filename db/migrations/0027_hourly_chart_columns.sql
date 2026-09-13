-- Let charts survive the raw-retention cutoff.
--
-- telemetry_hourly carried enough to rebuild a REPORT past the 90-day cutoff
-- (energy counters, demand, power factor) but not enough to draw a CHART: no
-- voltage, current or frequency, and no battery power or irradiance, which are
-- the primary series for BESS and weather devices (PRIMARY_POWER_KEY in
-- contracts/devices.ts). A chart older than the cutoff therefore came back
-- empty on both stores.
--
-- Those two live in values_json rather than in a column, so they are rolled up
-- as fixed columns here: the key set is bounded and known (one primary key per
-- device type), which keeps the rollup a plain aggregate with no join to
-- meters and keeps the MySQL and Timescale schemas symmetric.
ALTER TABLE telemetry_hourly
  ADD COLUMN avg_voltage_l1 double NULL,
  ADD COLUMN avg_current_l1 double NULL,
  ADD COLUMN avg_frequency_hz double NULL,
  ADD COLUMN avg_battery_power_kw double NULL,
  ADD COLUMN avg_irradiance_wm2 double NULL;
