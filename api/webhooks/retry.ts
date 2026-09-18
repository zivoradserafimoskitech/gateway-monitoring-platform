// §9.15: the retry policy. Pure, so "how long until the fourth attempt" is a
// test rather than an argument.
//
// The queue exists because the alternative — send once, log the failure, move
// on — loses every event a receiver misses while it restarts. Thirty seconds
// of downtime on their side should not be a permanent hole in their data.

/** Attempts before a delivery is given up on and marked dead. */
export const MAX_ATTEMPTS = 8;

/** First delay, doubled each attempt. */
const BASE_DELAY_MS = 10_000;

/** Ceiling per attempt: an hour. Past that a receiver is down, not busy. */
const MAX_DELAY_MS = 3_600_000;

/**
 * Backoff for the Nth attempt (1-based), WITHOUT jitter.
 *
 * 10s, 20s, 40s, 80s, …, capped at an hour. Eight attempts spans a little
 * over four hours, which covers the two failures that actually happen — a
 * restart and a short outage — without keeping a dead endpoint in the queue
 * for days.
 */
export function backoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  // Shift rather than Math.pow so a large attempt cannot produce Infinity
  // before the cap is applied.
  const raw = n >= 30 ? MAX_DELAY_MS : BASE_DELAY_MS * 2 ** (n - 1);
  return Math.min(raw, MAX_DELAY_MS);
}

/**
 * When to try again, with jitter.
 *
 * The jitter is not decoration. Every delivery for one endpoint fails at the
 * same moment when that endpoint goes down, so an unjittered schedule retries
 * all of them in the same instant, forever — a thundering herd aimed at a
 * service that is already struggling. ±25% spreads them.
 */
export function nextAttemptAt(attempt: number, now: Date, rand: () => number = Math.random): Date {
  const base = backoffMs(attempt);
  const jittered = base * (0.75 + rand() * 0.5);
  return new Date(now.getTime() + Math.round(jittered));
}

export type DeliveryOutcome =
  | { kind: "delivered"; status: number }
  | { kind: "retry"; status: number | null; error: string }
  | { kind: "dead"; status: number | null; error: string };

/**
 * What to do about one attempt's result.
 *
 * The split that matters is 4xx versus 5xx. A 5xx or a network error means
 * "not now" — the receiver is broken and will likely recover. A 4xx means
 * "not ever": the receiver is telling us this request is wrong, and sending
 * the identical bytes another seven times will not make it right. Retrying
 * those is how a queue fills with deliveries that can never succeed.
 *
 * Two 4xx codes are exceptions, because they do not mean what the rest of the
 * range means: 408 (request timeout) and 429 (rate limited) are both explicit
 * requests to come back later.
 */
export function classify(
  status: number | null,
  error: string | null,
  attempt: number,
  maxAttempts: number = MAX_ATTEMPTS,
): DeliveryOutcome {
  if (status !== null && status >= 200 && status < 300) return { kind: "delivered", status };
  const msg = error ?? (status === null ? "no response" : `HTTP ${status}`);
  const permanent = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (permanent) return { kind: "dead", status, error: msg };
  if (attempt >= maxAttempts) return { kind: "dead", status, error: `${msg} (gave up after ${attempt} attempts)` };
  return { kind: "retry", status, error: msg };
}
