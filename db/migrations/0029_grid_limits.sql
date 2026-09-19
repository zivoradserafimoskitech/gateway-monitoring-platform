-- §9.2: site-level grid import/export limit with curtailment.
--
-- A grid connection agreement caps how much a site may draw and, more often
-- the binding one, how much it may push back. Exceeding it is a contractual
-- and in many markets a regulatory event, so the limit has to hold without a
-- human watching it.
--
-- Peak shaving (ems_peak_configs) is the neighbouring feature, not this one:
-- it discharges ONE battery above ONE threshold. A connection limit binds in
-- both directions, shares the work across several assets in a defined order,
-- and its hardest case — too much PV going out — needs generation turned DOWN,
-- which nothing in the system could do before.
--
-- curtail_kw is deliberately persisted rather than recomputed. Curtailing
-- changes the very measurement that asked for it, so the controller holds a
-- total and nudges it (up by the overshoot, down by the headroom, both capped
-- per tick) instead of recomputing from each reading, which would oscillate.
-- Persisting it means a restart resumes where it left off rather than
-- releasing the whole site at once.
CREATE TABLE IF NOT EXISTS grid_limits (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  site_id bigint unsigned NOT NULL,
  -- Meter at the point of common coupling. Its active_power_kw is signed:
  -- positive = import from the grid, negative = export to it.
  pcc_meter_id bigint unsigned NOT NULL,
  max_import_kw double NULL,
  -- Positive magnitude, not a negative number: "export at most 100 kW".
  max_export_kw double NULL,
  deadband_kw double NOT NULL DEFAULT 5,
  max_step_kw double NOT NULL DEFAULT 25,
  curtail_kw double NOT NULL DEFAULT 0,
  enabled tinyint(1) NOT NULL DEFAULT 1,
  org_id bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY grid_limits_site_unique (site_id),
  KEY grid_limits_org_idx (org_id)
);

-- Which assets may be curtailed, and in what order. Lower priority curtails
-- first: the column exists so an operator can put a leased array ahead of an
-- owned one and have that obeyed rather than averaged away by proportional
-- sharing.
CREATE TABLE IF NOT EXISTS curtailment_assets (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  site_id bigint unsigned NOT NULL,
  meter_id bigint unsigned NOT NULL,
  priority int NOT NULL DEFAULT 100,
  -- Nameplate kW: the denominator when the limit register is a percentage.
  rated_kw double NOT NULL,
  enabled tinyint(1) NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY curtail_asset_site_meter_unique (site_id, meter_id),
  KEY curtail_asset_site_idx (site_id)
);
