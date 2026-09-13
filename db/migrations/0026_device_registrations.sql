-- Give a self-announcing device a tenant at provisioning time.
--
-- MQTT auto-provisioning creates a gateway the first time hardware publishes.
-- Ingestion is a shared subscription, so the broker's authenticated publisher
-- identity never reaches the application: all we have is a UID on a topic.
-- Every auto-provisioned row therefore landed with org_id NULL, and under org
-- scoping a NULL-org device is invisible to EVERY tenant — the hardware
-- ingests into a database nobody can see, which looks exactly like a device
-- that never connected.
--
-- Serial numbers are known before hardware ships, so this table lets an admin
-- say in advance which org a UID belongs to; the gateway is stamped with that
-- org (and optionally a site) the moment it appears. Two other paths were
-- added alongside it in code: MQTT_DEFAULT_ORG_ID for single-tenant
-- installations, and auto-provisioned meters inheriting their gateway's org
-- instead of being left NULL under an owned gateway.
--
-- A device with no registration still lands unclaimed and shows up in the
-- superadmin queue. That is deliberate: guessing a tenant is worse than
-- showing the device in a list.
CREATE TABLE IF NOT EXISTS device_registrations (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  uid varchar(64) NOT NULL,
  org_id bigint unsigned NOT NULL,
  site_id bigint unsigned,
  note varchar(255),
  created_by bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at timestamp NULL,
  gateway_id bigint unsigned,
  -- One registration per UID: two rows claiming the same device for different
  -- tenants is the one state this table must not be able to reach.
  UNIQUE KEY device_reg_uid_unique (uid),
  KEY device_reg_org_idx (org_id)
);
