// Operational counters for the UI.
//
// The meter/gateway detail pages used to fetch the Prometheus text endpoint
// (/metrics) from the BROWSER and regex the counters out of it. That coupled
// the UI to a scrape format and broke outright in the recommended deployment,
// where docs/ha.md restricts /metrics to the monitoring system at the proxy.
// /metrics stays the machine surface; this is the application surface.
import { createRouter, authed } from "../middleware";
import { getC30UndecodableCounts, getTelemetryRejectionStats } from "../lib/observability";

export const diagnosticsRouter = createRouter({
  // Per-register-key counts of decoded values dropped by the profile's
  // plausibility bounds. A wrong scale factor shows up here as a spike
  // instead of as silently stored bad data.
  telemetryRejections: authed.query(() => {
    const stats = getTelemetryRejectionStats();
    let rejected = 0;
    let decoded = 0;
    const byKey: Record<string, { rejected: number; decoded: number }> = {};
    for (const [key, v] of Object.entries(stats)) {
      rejected += v.rejected;
      decoded += v.decoded;
      if (v.rejected > 0) byKey[key] = v;
    }
    return {
      rejected,
      decoded,
      // Share of decoded values that were dropped, 0 when nothing decoded yet.
      rejectedRatio: decoded + rejected > 0 ? rejected / (decoded + rejected) : 0,
      byKey,
      at: Date.now(),
    };
  }),

  // C30 transparent frames that could not be attributed to a known read block.
  // These are the visible signal of the "drop over guess" policy working — or
  // of a misconfigured register map.
  c30Undecodable: authed.query(() => {
    const byReason = getC30UndecodableCounts();
    let total = 0;
    for (const v of Object.values(byReason)) total += v;
    return { total, byReason, at: Date.now() };
  }),
});
