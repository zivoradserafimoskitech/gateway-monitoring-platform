-- audit #23: opt-in TOTP MFA.
-- totp_secret_enc holds the AES-256-GCM encrypted base32 TOTP secret
-- (format v1:<ivHex>:<tagHex>:<cipherHex>, see api/lib/totp.ts); NULL = never
-- started setup. totp_enabled flips to 1 only after the setup code verifies.
-- Non-destructive ADD COLUMN — safe to apply online.
ALTER TABLE users ADD COLUMN totp_secret_enc varchar(255) NULL, ADD COLUMN totp_enabled tinyint NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Single-use backup codes; only sha256 hashes are stored (shown once, like API keys).
CREATE TABLE mfa_backup_codes (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id bigint unsigned NOT NULL,
  code_hash varchar(64) NOT NULL,
  used_at timestamp NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX mfa_backup_user_idx (user_id)
);
