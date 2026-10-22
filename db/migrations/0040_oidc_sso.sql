-- §9.12: OIDC single sign-on.
--
-- A procurement blocker rather than a feature: industrial customers hand over
-- their SSO requirements before they will discuss anything else, and "we have
-- our own login form" ends the conversation.
--
-- Per-provider and DISABLED by default, and password login is never removed.
-- This is the one item on the §9 list that cannot be proved end to end in CI,
-- because there is no identity provider on a runner. What is proved there is
-- every decision that makes a token trustworthy — signature, algorithm, issuer,
-- audience, expiry, nonce, and the provisioning policy (api/auth/oidc.ts plus
-- tests/oidc.test.ts, which generate their own keys and sign their own tokens).
-- The untested part is the network round trip to a real IdP.
CREATE TABLE IF NOT EXISTS oidc_providers (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name varchar(255) NOT NULL,
  -- Compared EXACTLY against the id_token's iss: a prefix or suffix test would
  -- let "https://issuer.example.evil.com" through.
  issuer varchar(500) NOT NULL,
  client_id varchar(255) NOT NULL,
  -- AES-256-GCM at rest, through the same helper as the TOTP secrets: the
  -- client secret authenticates this system to the IdP, so a database dump must
  -- not be enough to impersonate it.
  client_secret_enc varchar(1000) NULL,
  authorization_endpoint varchar(500) NOT NULL,
  token_endpoint varchar(500) NOT NULL,
  jwks_uri varchar(500) NOT NULL,
  scopes varchar(255) NOT NULL DEFAULT 'openid email profile',
  -- Auto-provisioning with an EMPTY list is refused rather than read as "any
  -- domain": against a public IdP that would hand an account to the internet.
  allowed_domains json NULL,
  auto_provision tinyint(1) NOT NULL DEFAULT 0,
  -- Never taken from the token. Group mapping depends on the customer's group
  -- hygiene being perfect, and the failure mode is somebody granting
  -- themselves administration of a system that controls plant.
  default_role enum('admin','operator','viewer') NOT NULL DEFAULT 'viewer',
  enabled tinyint(1) NOT NULL DEFAULT 0,
  org_id bigint unsigned,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY oidc_providers_org_idx (org_id)
);

-- In-flight logins. In the database rather than in process memory because the
-- callback can land on a different replica from the one that started the flow —
-- the same reason the login lockout and the pending MFA challenge moved out of
-- memory earlier in this branch.
CREATE TABLE IF NOT EXISTS oidc_logins (
  state varchar(64) NOT NULL PRIMARY KEY,
  provider_id bigint unsigned NOT NULL,
  nonce varchar(64) NOT NULL,
  code_verifier varchar(128) NOT NULL,
  -- Validated as a local path before use: an open redirect on a login callback
  -- is how a phishing page borrows somebody else's domain.
  redirect_to varchar(500) NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY oidc_logins_expiry_idx (expires_at)
);
