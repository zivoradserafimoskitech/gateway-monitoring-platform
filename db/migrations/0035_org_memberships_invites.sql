-- §9.11: organization membership, invites and switching.
--
-- A user belonged to exactly one org (users.org_id) with one global role. Two
-- things that come up constantly were therefore impossible: an engineer who
-- looks after three customers' sites needs access to three tenants, and an
-- installer commissioning a new site needs to be brought in without somebody
-- typing a password on their behalf and sending it over chat.
--
-- Membership is ADDITIVE rather than a rewrite of the scoping model.
-- users.org_id and users.role keep their meaning — the ACTIVE org and the role
-- in it — so every org-scoped query, guard and router is untouched. Switching
-- org means checking a membership and moving those two fields. The invariant
-- is one sentence: users.org_id/users.role mirror the membership the user is
-- currently acting under.
CREATE TABLE IF NOT EXISTS org_memberships (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id bigint unsigned NOT NULL,
  org_id bigint unsigned NOT NULL,
  -- The role IN THIS ORG. The same person can be an operator for one tenant
  -- and a viewer for another, which is the usual arrangement when a contractor
  -- looks after several customers.
  role enum('admin','operator','viewer') NOT NULL DEFAULT 'viewer',
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY org_membership_unique (user_id, org_id),
  KEY org_membership_user_idx (user_id),
  KEY org_membership_org_idx (org_id)
);

-- Backfill: every existing user becomes a member of the org they are already
-- in, with the role they already have. Without this, the first person to open
-- the org switcher after deploying would find they belong to nothing.
INSERT IGNORE INTO org_memberships (user_id, org_id, role)
  SELECT id, org_id, role FROM users WHERE org_id IS NOT NULL;

-- Invites. The token is stored HASHED, like a session token and an API key: a
-- database dump must not hand somebody the ability to create accounts in every
-- tenant that has an invite outstanding.
CREATE TABLE IF NOT EXISTS org_invites (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id bigint unsigned NOT NULL,
  email varchar(255) NOT NULL,
  role enum('admin','operator','viewer') NOT NULL DEFAULT 'viewer',
  token_hash varchar(64) NOT NULL,
  invited_by bigint unsigned NULL,
  -- Invites expire. One that does not is a credential with no owner sitting in
  -- an inbox indefinitely.
  expires_at timestamp NOT NULL,
  accepted_at timestamp NULL,
  accepted_user_id bigint unsigned NULL,
  revoked_at timestamp NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY org_invite_token_unique (token_hash),
  KEY org_invite_org_idx (org_id),
  KEY org_invite_email_idx (email)
);
