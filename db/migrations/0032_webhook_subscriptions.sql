-- §9.15: outbound webhook subscriptions with signed payloads and a retry queue.
--
-- notification_channels already POST alarm JSON at a URL, which is enough for
-- a Slack hook and not enough for an integration. Three things were missing,
-- and each one is a reason an integrator refuses to build against a system:
--
--   1. Nothing SIGNED the payload, so a receiver had no way to distinguish a
--      genuine delivery from anyone who learned the URL.
--   2. A failed delivery was logged as failed and dropped. A receiver that was
--      restarting for thirty seconds lost every event in that window,
--      permanently, with no way to ask for them again.
--   3. The only event was "an alarm fired". Control actions — the ones an
--      auditor actually asks about — were never published at all.
--
-- The secret is stored in plaintext, unlike api_keys which stores a hash. The
-- difference is not an oversight: a key is COMPARED against what a caller
-- presents, while this secret must be REPRODUCED to sign each delivery. It is
-- returned once at creation and on rotation, and never by a list query.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name varchar(255) NOT NULL,
  url varchar(1000) NOT NULL,
  secret varchar(128) NOT NULL,
  -- JSON array of event names. An empty array subscribes to nothing, so the
  -- API refuses it rather than storing a webhook that can never fire.
  events json NOT NULL,
  enabled tinyint(1) NOT NULL DEFAULT 1,
  -- Surfaced, never acted on automatically. A subscription that disables
  -- itself after N failures is how a customer discovers weeks later that
  -- their ERP stopped receiving alarms.
  consecutive_failures int NOT NULL DEFAULT 0,
  last_success_at timestamp NULL,
  last_error_at timestamp NULL,
  last_error varchar(500) NULL,
  org_id bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY webhook_subs_org_idx (org_id)
);

-- One row per (event, subscription). The queue IS the retry: the row is
-- written before anything is sent, so a process that dies mid-send resumes
-- rather than losing the event, and next_attempt_at holds the schedule so a
-- restart does not stampede every pending delivery at once.
--
-- payload freezes the body at emit time. A retry must re-send the event as it
-- was: an alarm that has since resolved must not be re-delivered as "raised"
-- carrying a resolved body.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subscription_id bigint unsigned NOT NULL,
  event varchar(64) NOT NULL,
  payload json NOT NULL,
  status enum('pending','delivered','dead') NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  response_status int NULL,
  last_error varchar(500) NULL,
  delivered_at timestamp NULL,
  org_id bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY webhook_deliv_due_idx (status, next_attempt_at),
  KEY webhook_deliv_sub_idx (subscription_id),
  KEY webhook_deliv_org_idx (org_id)
);
