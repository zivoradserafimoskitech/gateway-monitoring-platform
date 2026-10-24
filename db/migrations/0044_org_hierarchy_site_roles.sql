-- Installer / O&M organisation hierarchy and fine-grained per-site roles.
-- Additive: every existing org stays top-level ("direct"), no site roles, so
-- access is unchanged until a superadmin sets a parent or an admin grants one.
ALTER TABLE orgs ADD COLUMN parent_org_id BIGINT UNSIGNED NULL;
ALTER TABLE orgs ADD COLUMN kind ENUM('direct','installer','om','customer') NOT NULL DEFAULT 'direct';
CREATE INDEX orgs_parent_idx ON orgs (parent_org_id);
CREATE TABLE IF NOT EXISTS site_roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  site_id BIGINT UNSIGNED NOT NULL,
  org_id BIGINT UNSIGNED NOT NULL,
  role ENUM('site_admin','site_operator','field_tech','site_viewer') NOT NULL,
  extra JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY site_roles_unique (user_id, site_id),
  KEY site_roles_user_idx (user_id),
  KEY site_roles_org_idx (org_id)
);
