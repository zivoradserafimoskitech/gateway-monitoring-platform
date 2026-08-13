-- audit P1-7: api_keys expiry + scopes.
-- expires_at NULL = never expires; scopes NULL = full access per role (legacy keys).
-- Non-destructive ADD COLUMN … NULL — safe to apply online.
ALTER TABLE api_keys ADD COLUMN expires_at timestamp NULL, ADD COLUMN scopes json NULL;
