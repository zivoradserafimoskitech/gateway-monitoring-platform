-- §9.5: battery state of health and cycle counting.
--
-- A BESS is the most expensive thing on most of these sites and the only one
-- that wears out by being used. Nothing measured that: the platform knew a
-- battery's SoC at any instant and nothing at all about how much life had been
-- taken out of it. Warranties are written in equivalent full cycles and in
-- retained capacity, so an installation could not answer the two questions its
-- own contract is actually about.
--
-- Everything here is derived from ordinary telemetry — SoC percentage and
-- battery power — because that is all these devices report. No special
-- instrumentation and no manufacturer API.
CREATE TABLE IF NOT EXISTS battery_health (
  meter_id bigint unsigned NOT NULL PRIMARY KEY,
  -- Usable nameplate energy. Set by a human: it is a fact about the hardware,
  -- not something telemetry can reveal, and every figure below is a ratio
  -- against it.
  nameplate_kwh double NULL,
  -- Equivalent full cycles: total SoC travelled / 200, the unit warranties are
  -- written in. Counting "times it reached 100%" instead would score a battery
  -- cycling between 40% and 60% all day as having done nothing, which is the
  -- opposite of the truth.
  efc double NOT NULL DEFAULT 0,
  throughput_discharged_kwh double NOT NULL DEFAULT 0,
  throughput_charged_kwh double NOT NULL DEFAULT 0,
  -- Exponentially blended across accepted measurement windows: capacity does
  -- not jump, so one odd window nudges this rather than redefining it.
  soh_pct double NULL,
  soh_samples int NOT NULL DEFAULT 0,
  last_estimate_at timestamp NULL,
  -- Sweep cursor and previous sample, so accumulation resumes across a restart
  -- instead of re-counting or skipping a stretch.
  last_ts timestamp NULL,
  last_soc_pct double NULL,
  last_power_kw double NULL,
  -- The discharge window currently being followed, if any.
  window_soc_start double NULL,
  window_kwh double NULL,
  org_id bigint unsigned,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY battery_health_org_idx (org_id)
);

-- Every accepted capacity measurement is kept rather than folded away. A
-- single SoH number with no working behind it is not something an operator can
-- argue with a supplier about, and a warranty claim is exactly an argument.
CREATE TABLE IF NOT EXISTS battery_capacity_estimates (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  meter_id bigint unsigned NOT NULL,
  started_at timestamp NOT NULL,
  ended_at timestamp NOT NULL,
  soc_start double NOT NULL,
  soc_end double NOT NULL,
  discharged_kwh double NOT NULL,
  estimated_kwh double NOT NULL,
  soh_pct double NULL,
  org_id bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY battery_cap_meter_idx (meter_id),
  KEY battery_cap_org_idx (org_id)
);
