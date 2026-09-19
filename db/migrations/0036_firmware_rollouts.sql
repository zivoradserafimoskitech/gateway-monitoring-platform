-- §9.9: firmware releases and staged rollouts.
--
-- Firmware could only be pushed one gateway at a time, from an ad-hoc payload
-- carrying whatever URL somebody typed into the ticket. A fleet update was
-- therefore a script looping over every gateway — which is how an installation
-- loses all of them at the same moment to a bad image.
--
-- Firmware is not a setpoint: it cannot be reliably rolled back over the air,
-- and a gateway that boots into an image which no longer reaches the broker is
-- beyond anything this system can do. So the design is one idea — find out on
-- ONE device, then a few, then the rest, and STOP the moment the numbers look
-- wrong. There is no automatic rollback because there cannot be one.

-- A release registry means a rollout points at a KNOWN artifact rather than at
-- a URL that was correct when it was pasted.
CREATE TABLE IF NOT EXISTS firmware_releases (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  model varchar(128) NOT NULL,
  version varchar(64) NOT NULL,
  url varchar(1000) NOT NULL,
  -- sha256 of the image. The gateway verifies before flashing; recording it
  -- means "which bytes did we ship" still has an answer months later, when the
  -- question is asked by somebody holding a device that no longer boots.
  sha256 varchar(64) NULL,
  notes varchar(1000) NULL,
  org_id bigint unsigned,
  created_by bigint unsigned NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY firmware_model_version_unique (model, version),
  KEY firmware_org_idx (org_id)
);

CREATE TABLE IF NOT EXISTS ota_rollouts (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  release_id bigint unsigned NOT NULL,
  name varchar(255) NOT NULL,
  -- The canary gets its own wave even when it is a single device: a rollout
  -- that starts with ten is a rollout that can break ten.
  canary_count int NOT NULL DEFAULT 1,
  batch_size int NOT NULL DEFAULT 10,
  failure_threshold_pct int NOT NULL DEFAULT 10,
  status enum('draft','running','paused','halted','completed') NOT NULL DEFAULT 'draft',
  halt_reason varchar(500) NULL,
  created_by bigint unsigned NULL,
  org_id bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at timestamp NULL,
  finished_at timestamp NULL,
  KEY ota_rollouts_org_idx (org_id),
  KEY ota_rollouts_status_idx (status)
);

-- Membership is FROZEN when the rollout is created rather than re-evaluated
-- from a filter on every sweep: a gateway that comes online halfway through
-- must not silently join a wave that has already been judged.
CREATE TABLE IF NOT EXISTS ota_rollout_targets (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rollout_id bigint unsigned NOT NULL,
  gateway_id bigint unsigned NOT NULL,
  batch_index int NOT NULL,
  status enum('pending','sent','ack','failed') NOT NULL DEFAULT 'pending',
  job_id bigint unsigned NULL,
  error varchar(500) NULL,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY ota_rollout_target_unique (rollout_id, gateway_id),
  KEY ota_rollout_target_rollout_idx (rollout_id)
);
