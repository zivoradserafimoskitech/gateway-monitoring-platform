-- Multi-tenancy: org ownership for notification channels, maintenance windows,
-- delivery history and the audit log; source attribution for the audit log.
--
-- Before this migration none of these tables carried an org, with three
-- consequences:
--   1. Alarm notifications were dispatched to EVERY enabled channel, so one
--      tenant's alarm reached another tenant's webhook, Telegram chat and
--      mailbox.
--   2. Any operator could list and edit every tenant's channels, maintenance
--      windows and delivery history.
--   3. A per-tenant audit view was impossible to build, and audit rows recorded
--      no source address for actions that command plant.
--
-- NULL org_id is preserved as "global": a superadmin-owned channel or
-- suppression window that applies to every org. Existing rows therefore keep
-- their current behaviour after upgrade, and narrowing them to one tenant is a
-- deliberate follow-up action rather than a silent migration side effect.
--
-- All non-destructive ADD COLUMN / CREATE INDEX — safe online.

ALTER TABLE notification_channels
  ADD COLUMN org_id bigint unsigned NULL;
CREATE INDEX channels_org_idx ON notification_channels (org_id);

ALTER TABLE maintenance_windows
  ADD COLUMN org_id bigint unsigned NULL;
CREATE INDEX maint_org_idx ON maintenance_windows (org_id);

ALTER TABLE alarm_notifications
  ADD COLUMN org_id bigint unsigned NULL;
CREATE INDEX alarm_notif_org_idx ON alarm_notifications (org_id);

ALTER TABLE audit_log
  ADD COLUMN org_id bigint unsigned NULL,
  ADD COLUMN ip varchar(45) NULL,
  ADD COLUMN user_agent varchar(255) NULL;
CREATE INDEX audit_org_idx ON audit_log (org_id);

-- Backfill: an existing audit row's org is the acting user's org.
UPDATE audit_log a
  JOIN users u ON u.id = a.user_id
  SET a.org_id = u.org_id
  WHERE a.org_id IS NULL AND a.user_id IS NOT NULL;
