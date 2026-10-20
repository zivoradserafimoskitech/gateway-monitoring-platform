-- §9.3: tariffs and tariff-aware optimisation.
--
-- The EMS could discharge on a schedule and shave a peak. Neither knows what
-- electricity costs, so the thing a battery is actually bought for on a
-- commercial site — buy cheap, use dear — had to be approximated by a human
-- writing time windows by hand and editing them whenever the contract changed.
--
-- Two price sources, because both exist in the field and neither covers the
-- other: a time-of-use schedule (what most industrial supply contracts are)
-- and an imported hourly curve (what a market-exposed site needs). An explicit
-- hourly price beats the schedule for that hour. Where neither says anything
-- there is NO price, and the optimiser refuses to plan rather than guessing.
CREATE TABLE IF NOT EXISTS tariffs (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name varchar(255) NOT NULL,
  -- NULL = the org's default tariff; a site-bound tariff wins over it.
  site_id bigint unsigned NULL,
  currency varchar(8) NOT NULL DEFAULT 'EUR',
  -- Periods are read in local time: a contract's "peak 17:00-21:00" is local,
  -- and reading it as UTC is wrong twice a year.
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  enabled tinyint(1) NOT NULL DEFAULT 1,
  org_id bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY tariffs_org_idx (org_id),
  KEY tariffs_site_idx (site_id)
);

-- Same window shape as ems_schedules (bit 0 = Sunday, equal start and end
-- means all day, end before start wraps midnight), so an operator learns one
-- convention rather than three.
CREATE TABLE IF NOT EXISTS tariff_periods (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tariff_id bigint unsigned NOT NULL,
  label varchar(64) NULL,
  day_of_week_mask int NOT NULL DEFAULT 127,
  start_min int NOT NULL DEFAULT 0,
  end_min int NOT NULL DEFAULT 0,
  import_price double NOT NULL,
  -- NULL means export is not paid, which is NOT the same as zero in the
  -- optimiser's arithmetic.
  export_price double NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY tariff_periods_tariff_idx (tariff_id)
);

CREATE TABLE IF NOT EXISTS tariff_prices (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tariff_id bigint unsigned NOT NULL,
  hour_start timestamp NOT NULL,
  import_price double NOT NULL,
  export_price double NULL,
  -- Where the number came from, so a surprising plan can be traced back to the
  -- feed that justified it.
  source varchar(64) NOT NULL DEFAULT 'manual',
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY tariff_price_hour_unique (tariff_id, hour_start)
);

-- Per-battery economics. Separate from battery_health because that table is
-- MEASURED and this one is CONFIGURED; mixing what the system observed with
-- what a human asserted is how a figure nobody can source ends up in a
-- contract conversation.
CREATE TABLE IF NOT EXISTS battery_economics (
  meter_id bigint unsigned NOT NULL PRIMARY KEY,
  max_power_kw double NOT NULL,
  round_trip_efficiency double NOT NULL DEFAULT 0.9,
  min_soc_pct double NOT NULL DEFAULT 20,
  max_soc_pct double NOT NULL DEFAULT 90,
  -- The number that decides whether arbitrage is worth doing at all. A battery
  -- has a finite number of cycles in it; spending one to capture a spread
  -- smaller than the wear it costs loses money while every chart calls the
  -- plan a success. Zero is legitimate for a leased asset but has to be chosen.
  cycle_cost double NOT NULL DEFAULT 0,
  -- Off by default: a planner that starts commanding a battery because
  -- somebody filled in a price table is not a planner anybody asked for.
  optimizer_enabled tinyint(1) NOT NULL DEFAULT 0,
  org_id bigint unsigned,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY battery_econ_org_idx (org_id)
);
