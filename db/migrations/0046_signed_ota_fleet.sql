-- Signed firmware releases + fleet management (tags, groups).
ALTER TABLE firmware_releases ADD COLUMN signature VARCHAR(256) NULL, ADD COLUMN signing_key_id VARCHAR(64) NULL;
ALTER TABLE gateways ADD COLUMN tags JSON NULL;
CREATE TABLE gateway_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(500) NULL,
  org_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY gateway_groups_org_name_unique (org_id, name)
);
CREATE TABLE gateway_group_members (
  group_id BIGINT UNSIGNED NOT NULL,
  gateway_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY gateway_group_members_unique (group_id, gateway_id),
  KEY gateway_group_members_gw_idx (gateway_id)
);
