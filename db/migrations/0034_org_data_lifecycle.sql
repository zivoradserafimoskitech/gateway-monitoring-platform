-- §9.14: per-org retention, data export and a deletion path.
--
-- Three gaps with one thing in common: a tenant's data had no lifecycle of its
-- own. It was kept for a period the deployment chose, it could not be handed
-- back, and it could not be removed except by somebody deleting rows by hand
-- in whatever order occurred to them.

-- 1. Retention per tenant. One global TELEMETRY_RAW_DAYS cannot serve two
--    tenants at once: one under a regulator requiring five years of interval
--    data and one who wants nothing kept past a month are both reasonable
--    requests, and a single figure has to be wrong for one of them. NULL keeps
--    the deployment default, which is what every existing org has.
--
-- 2. The deletion path, scheduled rather than immediate. An irreversible
--    delete of a tenant's entire history, executed the instant somebody
--    clicks, has no way back from a misclick or a misread ticket. The grace
--    period IS the feature, and cancelling during it is a supported action
--    instead of a database restore.
ALTER TABLE orgs
  ADD COLUMN telemetry_raw_days int NULL,
  ADD COLUMN deletion_requested_at timestamp NULL,
  ADD COLUMN deletion_requested_by bigint unsigned NULL,
  ADD COLUMN deletion_scheduled_for timestamp NULL;

-- 3. Export. A tenant's data has to be able to leave: the request arrives as a
--    contract clause, as a regulator's question, or on the day a customer
--    moves to another supplier and is entitled to take their history with
--    them. The only routes out before this were a scheduled energy report (one
--    metric, emailed) and direct database access (everyone's data at once).
--
-- Built asynchronously because it is not a request-sized job — a year of
-- interval data for one site is tens of millions of rows.
CREATE TABLE IF NOT EXISTS data_exports (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id bigint unsigned NOT NULL,
  requested_by bigint unsigned NULL,
  status enum('pending','running','ready','failed','expired') NOT NULL DEFAULT 'pending',
  -- Telemetry is opt-in and range-bounded: most requests are for configuration
  -- and alarms, and defaulting to "every sample ever" would make the common
  -- case unusably slow.
  include_telemetry tinyint(1) NOT NULL DEFAULT 0,
  range_from timestamp NULL,
  range_to timestamp NULL,
  file_path varchar(500) NULL,
  size_bytes bigint unsigned NULL,
  -- Per-table counts, so the recipient can check they got everything rather
  -- than trusting that a file which opened is a file that is complete.
  row_counts json NULL,
  -- Random, short-lived and re-issuable. The token travels in a URL, and URLs
  -- end up in proxy logs and browser history.
  download_token varchar(64) NULL,
  token_expires_at timestamp NULL,
  error varchar(500) NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at timestamp NULL,
  completed_at timestamp NULL,
  -- The archive is removed from disk after this. An export sitting on a server
  -- forever is a copy of a tenant's entire history that nobody is watching.
  expires_at timestamp NULL,
  KEY data_exports_org_idx (org_id),
  KEY data_exports_status_idx (status)
);
