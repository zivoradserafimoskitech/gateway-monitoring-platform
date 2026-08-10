// Offline-threshold policy (v5, finding #2).
//
// The old fixed 120 s cutoff was SHORTER than configured poll intervals (up to
// 3600 s), so slow-poll devices flapped online/offline on every cycle. The
// threshold is now derived per device from its reporting interval.

export const MIN_OFFLINE_AFTER_MS = 120_000;
export const OFFLINE_INTERVAL_FACTOR = 2.5;

/**
 * A device is offline only after 2.5× its poll interval without a sighting
 * (never less than 2 min): at 60 s interval → 150 s; at 3600 s → 2.5 h.
 */
export function offlineThresholdMs(pollIntervalSec?: number | null): number {
  const intervalMs = Math.max(5, pollIntervalSec ?? 60) * 1000;
  return Math.max(MIN_OFFLINE_AFTER_MS, Math.round(intervalMs * OFFLINE_INTERVAL_FACTOR));
}
