// Raw-telemetry retention window, shared by both stores.
//
// It lives in its own module because the Timescale store needs the cutoff too
// (reports older than it are rebuilt from hourly aggregates), and importing it
// from rollup.ts would drag the MySQL connection module into a deployment that
// stores no telemetry in MySQL at all.
//
// The value must stay in step with the Timescale retention policy in
// db/timescale/001_init.sql (drop_after => 90 days).
export const TELEMETRY_RAW_DAYS = parseInt(process.env.TELEMETRY_RAW_DAYS || "90", 10);

/** Raw rows older than this are rolled up + purged; reports read aggregates. */
export function retentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - TELEMETRY_RAW_DAYS * 86_400_000);
}

/**
 * Upper bound for the AGGREGATED half of a range that also has a raw half.
 *
 * The hour the cutoff falls inside is covered by both sources: the hourly
 * rollup holds that whole hour, and the raw rows from the cutoff onward are
 * still there too. Reading both double-counts it — samples come out inflated
 * and a weighted average leans toward the tail. The rollup's grain is one
 * hour, so the only clean split is on an hour boundary: everything strictly
 * before the cutoff's own hour comes from the rollup, and that hour onward
 * comes from raw. Nothing is lost, because raw still holds that hour.
 */
export function aggregateUpperBound(cutoff: Date): Date {
  const hourStart = Math.floor(cutoff.getTime() / 3_600_000) * 3_600_000;
  return new Date(hourStart - 1);
}
