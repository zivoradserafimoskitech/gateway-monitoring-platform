-- audit wave4: TOTP replay protection.
-- totp_last_step records the last accepted TOTP time-step (30s counter since
-- unix epoch). verifyTotp refuses any step <= totp_last_step, so a captured
-- code cannot be replayed inside the ±1-step window (up to 90s otherwise).
-- NULL = no TOTP code accepted yet (every valid step is > NULL semantics in
-- code, i.e. no restriction). Non-destructive ADD COLUMN — safe online.
ALTER TABLE users ADD COLUMN totp_last_step BIGINT NULL;
