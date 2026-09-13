// §9.7 data quality: a register that has frozen.
//
// This is the failure the rest of the alarm system cannot see. A Modbus
// register whose backing sensor has died, or whose gateway is replaying a
// cached frame, keeps returning the SAME plausible number forever. The device
// stays online, every threshold rule sees a value inside its limits, no alarm
// fires — and that number goes on feeding EMS charge/discharge decisions and
// monthly billing reports. "Offline" is loud; "stuck" is silent, which makes
// it the more dangerous of the two.
//
// Detection is exact equality, not a tolerance band. A live sensor jitters in
// its last digits even when the quantity it measures is steady; a frozen
// register returns bit-identical doubles. Exact equality is therefore both the
// most sensitive test and the one that cannot be tripped by a quiet signal —
// a tolerance band would call a genuinely steady 50.00 Hz supply "stuck".

/** What the evaluator remembers between samples, per rule and meter. */
export interface StuckRecord {
  /** Last value seen for the rule's metric. */
  value: number;
  /** When that value was first seen — the start of the unchanged run. */
  since: number;
}

export type StuckStep =
  /** The value moved: the run restarts here. */
  | { kind: "changed"; next: StuckRecord }
  /** Unchanged, but not yet for long enough to be worth a query. */
  | { kind: "unchanged"; next: StuckRecord }
  /** Unchanged for at least the rule's window — confirm against the database. */
  | { kind: "suspect"; next: StuckRecord; windowMs: number };

/**
 * Advance the in-memory run for one sample.
 *
 * Deliberately does no I/O: this runs on every telemetry sample of every
 * device, and the whole point of the design is that a healthy signal costs
 * nothing but a comparison. Only a "suspect" result earns a database query,
 * and only that query decides whether the alarm is real.
 */
export function stuckStep(
  prev: StuckRecord | undefined,
  value: number,
  now: number,
  windowMs: number,
): StuckStep {
  if (prev === undefined || !Object.is(prev.value, value)) {
    // Object.is rather than ===: a stuck NaN is still stuck, and -0 arriving
    // after 0 is a change in the register even though 0 === -0.
    return { kind: "changed", next: { value, since: now } };
  }
  const next = prev;
  // A window of zero would make the first repeated sample "stuck", which for a
  // device reporting twice a second is every device, all the time.
  if (windowMs > 0 && now - prev.since >= windowMs) {
    return { kind: "suspect", next, windowMs };
  }
  return { kind: "unchanged", next };
}

/**
 * Reconcile the in-memory run with what the database actually holds.
 *
 * `changedAt` is the timestamp of the most recent sample in the window whose
 * value differs, or null when every stored sample in the window is identical.
 * The database is the authority because the in-memory run is per replica and
 * is lost on restart: without this, a restart would silently reset the clock
 * and a register stuck for a week would never reach its window.
 */
export function confirmStuck(
  rec: StuckRecord,
  changedAt: number | null,
  now: number,
  windowMs: number,
): { stuck: boolean; next: StuckRecord } {
  if (changedAt === null) return { stuck: true, next: rec };
  // Something in the window disagreed with our run — trust the stored sample
  // and restart from there, so the next window is measured from the truth
  // rather than from when this replica happened to start.
  const next: StuckRecord = { value: rec.value, since: changedAt };
  return { stuck: now - changedAt >= windowMs, next };
}
