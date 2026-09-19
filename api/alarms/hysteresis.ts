// Alarm hysteresis and duration, as a pure decision.
//
// An alarm fires on the transition INTO breach and resolves on the transition
// out. Re-alarming requires a new breach, so acknowledging or resolving in the
// UI while the condition persists does not spawn a fresh alarm.
//
// Duration ("breached for N minutes") is what makes a noisy signal usable: a
// single sample over the threshold is almost never worth waking somebody for.
// It needs the instant the condition STARTED, which is why the state is
// durable rather than a per-process map — a restart used to reset the clock,
// so a flapping site could never accumulate enough time to alarm.

export interface BreachRecord {
  breached: boolean;
  /** When the condition started. Null when not breached. */
  since: number | null;
  /** When the rule actually fired. Null while the condition is still young. */
  raisedAt: number | null;
}

export type AlarmAction =
  /** Nothing to do; `next` may still differ (the clock started). */
  | { action: "none"; next: BreachRecord }
  /** Raise now: the condition has held for long enough. */
  | { action: "raise"; next: BreachRecord }
  /** Clear: the condition ended after an alarm had been raised. */
  | { action: "clear"; next: BreachRecord };

/**
 * Decide what a single evaluation should do.
 *
 * @param rec         stored state for this (rule, device) pair
 * @param breached    does the current sample violate the threshold?
 * @param now         epoch milliseconds
 * @param durationMs  how long the condition must hold before raising; 0 = at once
 */
export function alarmTransition(
  rec: BreachRecord,
  breached: boolean,
  now: number,
  durationMs: number,
): AlarmAction {
  if (breached) {
    // Start the clock on the first breaching sample and keep it running.
    const since = rec.since ?? now;
    if (rec.raisedAt !== null) {
      // Already raised and still breaching: nothing further to do.
      return { action: "none", next: { breached: true, since, raisedAt: rec.raisedAt } };
    }
    if (now - since >= durationMs) {
      return { action: "raise", next: { breached: true, since, raisedAt: now } };
    }
    // Breaching, but not for long enough yet.
    return { action: "none", next: { breached: true, since, raisedAt: null } };
  }

  // Not breaching.
  const cleared: BreachRecord = { breached: false, since: null, raisedAt: null };
  if (rec.raisedAt !== null) {
    // An alarm exists for a condition that has ended.
    return { action: "clear", next: cleared };
  }
  if (rec.breached) {
    // The condition ended before it lasted long enough to raise anything.
    // Reset the clock silently — this is exactly what duration is for.
    return { action: "none", next: cleared };
  }
  return { action: "none", next: cleared };
}
