-- Move the last of the per-process state into the database.
--
-- Three module-level Maps behaved incorrectly with more than one replica:
--
--   login_attempts       Each replica counted failures independently, so the
--                        brute-force budget was five attempts PER REPLICA
--                        rather than five in total.
--   mfa_pending          A challenge issued by one replica did not exist on
--                        the other, so a correct second factor was rejected
--                        whenever the load balancer moved the request.
--   alarm_breach_state   MQTT ingestion is deliberately not leased — the
--                        shared subscription balances it across replicas on
--                        purpose — so both replicas evaluated the same rules
--                        with separate hysteresis. A breach could be raised
--                        twice, or a clear missed entirely.
--
-- alarm_breach_state.since records when the condition STARTED, which is what a
-- "breached for N minutes" rule needs and what a restart used to discard.
--
-- All CREATE TABLE — safe online.

CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key varchar(160) NOT NULL PRIMARY KEY,
  failures json NOT NULL,
  locked_until timestamp NULL,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE INDEX login_attempts_updated_idx ON login_attempts (updated_at);

CREATE TABLE IF NOT EXISTS mfa_pending (
  token varchar(64) NOT NULL PRIMARY KEY,
  user_id bigint unsigned NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX mfa_pending_created_idx ON mfa_pending (created_at);

CREATE TABLE IF NOT EXISTS alarm_breach_state (
  rule_id bigint unsigned NOT NULL,
  meter_id bigint unsigned NOT NULL,
  breached boolean NOT NULL DEFAULT false,
  since timestamp NULL,
  raised_at timestamp NULL,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (rule_id, meter_id)
);

-- Alarm duration: how long a condition must hold before the rule raises.
-- 0 keeps the previous behaviour (raise on the first breaching sample), so
-- every existing rule is unchanged.
ALTER TABLE alarm_rules
  ADD COLUMN duration_sec int NOT NULL DEFAULT 0;
