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
