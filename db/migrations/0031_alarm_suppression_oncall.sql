-- §9.8: targeted alarm suppression and an on-call rota.
--
-- Maintenance windows (v7/C2) silence a whole SITE for a period and block the
-- alarm from being raised at all. Two things were missing around them.
--
-- First, the narrow case that actually comes up in operation: one rule, or one
-- device, is known to be misbehaving and should stop paging people while it is
-- being fixed — without going dark on everything else at that site. And when
-- it does, the alarm should still be RAISED and still appear in history,
-- carrying the reason it was not sent. A maintenance window loses the record
-- that the condition ever happened; suppression means "do not wake anyone",
-- not "pretend it did not occur".
CREATE TABLE IF NOT EXISTS alarm_suppressions (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- What is silenced: one rule, one device, or one site.
  scope enum('rule','meter','site') NOT NULL,
  ref_id bigint unsigned NOT NULL,
  starts_at timestamp NOT NULL,
  ends_at timestamp NOT NULL,
  -- NOT NULL on purpose: a suppression with no reason is how an installation
  -- ends up permanently quiet with nobody remembering why.
  reason varchar(255) NOT NULL,
  created_by bigint unsigned NULL,
  org_id bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY alarm_supp_scope_idx (scope, ref_id),
  KEY alarm_supp_org_idx (org_id)
);

ALTER TABLE alarms
  ADD COLUMN suppressed_reason varchar(255) NULL;

-- Second, who is on duty. Without a rota every channel receives everything at
-- every hour, which is how a 03:00 page reaches six people who cannot act on
-- it and one who can.
--
-- Opt-in by construction: an org with NO enabled shifts keeps the pre-rota
-- behaviour and every channel is notified. A rota that quietly pages nobody
-- because somebody half-configured it is worse than no rota at all. For the
-- same reason dispatch fails OPEN on an hour the rota does not cover — a
-- duplicate page is recoverable, a missed one is not.
CREATE TABLE IF NOT EXISTS on_call_shifts (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel_id bigint unsigned NOT NULL,
  -- Same shape as ems_schedules: bit 0 = Sunday.
  day_of_week_mask int NOT NULL DEFAULT 127,
  start_min int NOT NULL DEFAULT 0,
  -- Equal start and end means all day; end < start wraps past midnight, which
  -- is what a night shift is.
  end_min int NOT NULL DEFAULT 0,
  -- The rota is read in a human's local time, not the server's.
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  enabled tinyint(1) NOT NULL DEFAULT 1,
  org_id bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY on_call_channel_idx (channel_id),
  KEY on_call_org_idx (org_id)
);
