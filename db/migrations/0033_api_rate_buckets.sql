-- §9.13: per-key, per-scope rate limiting for the public REST API.
--
-- docs/api-v1.md used to say "front the API with your reverse proxy". That is
-- not an answer: a proxy sees an IP and a path, not which API KEY is calling or
-- which SCOPE the call needs, so it cannot tell a polling dashboard from an
-- integration pushing EMS plans, and it cannot stop one tenant's key consuming
-- the capacity of everyone else's.
--
-- The bucket lives here rather than in process memory because an in-memory
-- limiter multiplies the published quota by the number of replicas and resets
-- on every deploy — the number in the documentation then is not the number.
-- The same reasoning moved login lockout and alarm hysteresis into the database
-- earlier in this branch.
--
-- One narrow row, written on every API request: a primary-key lookup and an
-- update, with no secondary indexes to maintain.
CREATE TABLE IF NOT EXISTS api_rate_buckets (
  key_id bigint unsigned NOT NULL,
  scope varchar(32) NOT NULL,
  -- Fractional on purpose: the refill is continuous, so a caller sitting
  -- exactly at the limit is spaced out evenly rather than let through in a
  -- clump once a minute.
  tokens double NOT NULL,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Compare-and-set counter. updated_at would be the natural version, but an
  -- equality test on a fractional timestamp depends on the driver
  -- round-tripping milliseconds exactly, and a silent mismatch there would make
  -- every write lose its race and disable the limiter with nobody noticing. An
  -- integer cannot fail that way.
  version int NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, scope)
);
