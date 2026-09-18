// §9.13: per-key, per-scope rate limiting for the public REST API.
//
// docs/api-v1.md used to say "front the API with your reverse proxy". That is
// not an answer: a proxy sees an IP and a path, not which API KEY is calling
// or which SCOPE the call needs, so it cannot tell a polling dashboard apart
// from an integration pushing EMS plans, and it cannot stop one tenant's key
// from consuming the capacity of every other tenant's.
//
// Limits are per (key, scope) rather than per key: the scopes cost different
// amounts. A /sites read is one cheap query; a telemetry range scan is not;
// an EMS plan push writes and then commands plant. One shared budget would
// have to be set at the price of the most expensive call, which throttles the
// cheap ones for no reason.
//
// The bucket lives in the DATABASE, not in process memory. An in-memory
// limiter multiplies the quota by the number of replicas and resets on every
// deploy, which means the published number is not the number — and the repo
// already moved login lockout and alarm hysteresis into the database for
// exactly this reason.

/** Persisted bucket state. */
export interface BucketState {
  tokens: number;
  updatedAt: Date;
}

export interface BucketLimit {
  /** Sustained rate, requests per minute. */
  perMinute: number;
  /** Bucket capacity — how much unused quota can be saved up and spent at once. */
  burst: number;
}

export interface BucketDecision {
  allowed: boolean;
  /** State to persist when the request was allowed. A rejected request writes
   *  nothing: its refill is a pure function of elapsed time, so the next read
   *  derives it again from the untouched row. */
  next: BucketState;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until one token is available again; 0 when the request passed. */
  retryAfterSec: number;
}

/**
 * Token bucket, as a pure function.
 *
 * A token bucket rather than a fixed window because a fixed window lets a
 * caller spend a full quota at 11:59:59 and another at 12:00:00 — twice the
 * published rate, at the worst possible moment, and the limit then does not
 * mean what the documentation says it means.
 *
 * Refill is continuous (fractional tokens), so a caller at exactly the limit
 * is spaced out evenly instead of being let through in a clump each minute.
 */
export function takeToken(
  state: BucketState | null,
  limit: BucketLimit,
  now: Date,
): BucketDecision {
  const ratePerMs = limit.perMinute / 60_000;
  // A missing row means a key that has not called yet: it starts full. Anything
  // else would charge a first-time caller for time it was not using.
  const prior = state ?? { tokens: limit.burst, updatedAt: now };
  // Clamp the elapsed time at zero. Clock skew between replicas, or an NTP
  // step backwards, would otherwise DRAIN the bucket — a negative refill is
  // the one way a rate limiter can lock out a caller who did nothing wrong.
  const elapsedMs = Math.max(0, now.getTime() - prior.updatedAt.getTime());
  const refilled = Math.min(limit.burst, prior.tokens + elapsedMs * ratePerMs);

  if (refilled >= 1) {
    const tokens = refilled - 1;
    return {
      allowed: true,
      next: { tokens, updatedAt: now },
      remaining: Math.floor(tokens),
      retryAfterSec: 0,
    };
  }
  // Not enough for this request: keep the refill, charge nothing, and say when
  // to come back. Rounded UP — advertising a moment that is still a fraction
  // early would make a well-behaved client retry into a second rejection.
  const needed = 1 - refilled;
  return {
    allowed: false,
    next: { tokens: refilled, updatedAt: now },
    remaining: 0,
    retryAfterSec: Math.max(1, Math.ceil(needed / (ratePerMs * 1000))),
  };
}

/**
 * Default limits per scope, overridable with env vars so an operator running a
 * single tenant on their own hardware is not stuck with numbers chosen for a
 * shared deployment.
 *
 * Burst equals the per-minute rate: a client that has been quiet may spend a
 * minute's worth at once, which is what a batch job looks like, and cannot
 * spend more.
 */
export function limitFor(scope: string): BucketLimit {
  const env = (name: string, fallback: number): number => {
    const raw = process.env[name];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  switch (scope) {
    // A range scan over telemetry costs far more than a row lookup.
    case "telemetry:read":
      return { perMinute: env("RATE_TELEMETRY_PER_MIN", 60), burst: env("RATE_TELEMETRY_PER_MIN", 60) };
    // Writes that reach plant. Low on purpose: nothing legitimate pushes
    // setpoints faster than this, and the cost of a runaway client here is
    // measured in equipment, not in database load.
    case "ems:write":
      return { perMinute: env("RATE_EMS_WRITE_PER_MIN", 30), burst: env("RATE_EMS_WRITE_PER_MIN", 30) };
    case "control":
      return { perMinute: env("RATE_CONTROL_PER_MIN", 30), burst: env("RATE_CONTROL_PER_MIN", 30) };
    default:
      return { perMinute: env("RATE_READ_PER_MIN", 120), burst: env("RATE_READ_PER_MIN", 120) };
  }
}
