// Setpoint deadman (controller-loss watchdog).
//
// The gap this closes: if the platform dies after commanding a battery to
// discharge at 500 kW, the battery holds that setpoint indefinitely. Nothing in
// the system notices, because the thing that would notice is the thing that
// died. Every serious energy-management system solves this the same way — the
// controller refreshes a vendor watchdog register on a cycle shorter than the
// inverter's own timeout, and the inverter falls back to a safe state by itself
// the moment the refreshes stop.
//
// Design notes:
//
//  * OFF unless a device profile declares a `watchdog` block. No existing
//    installation changes behaviour, because no profile has one yet.
//  * The refresh is an ordinary control write through executeControl, so it
//    inherits the whole safety chain already in place: the controllable
//    whitelist, the draft/bench/field verification gate, the range clamp and
//    the read-back. There is deliberately no second write path.
//  * It is NOT written through executeAndLog: a refresh every few seconds would
//    bury the command audit trail. Failures are logged and counted instead.
//  * The register address, the value to write and the device's own timeout are
//    per-model facts that can only be established against real hardware, which
//    is why they live in the profile and are filled in during bench
//    verification rather than being guessed here.
import type { ControllableMap } from "../control/execute";

export interface WatchdogConfig {
  /** Key in the profile's `controllable` map that holds the watchdog register. */
  key: string;
  /** Value written on each refresh (many vendors want a counter; a constant is the common case). */
  value: number;
  /** How often we intend to refresh, milliseconds. */
  intervalMs: number;
  /** The DEVICE's own timeout: how long it waits before reverting to safe state. */
  deviceTimeoutMs: number;
  description?: string;
}

/** Refresh at least this often regardless of configuration (sanity floor). */
export const MIN_INTERVAL_MS = 1_000;
/**
 * How many refreshes must fit inside the device's timeout window. Three means
 * two consecutive refreshes can be lost — to a slow bus, a retry, a GC pause —
 * before the device gives up on us. Two would make a single missed refresh a
 * coin flip.
 */
export const REFRESHES_PER_TIMEOUT = 3;

/**
 * Validate a watchdog block against the profile it belongs to.
 * Returns null when usable, else a human-readable reason.
 */
export function validateWatchdog(cfg: unknown, controllable: ControllableMap): string | null {
  if (cfg === null || cfg === undefined) return null; // absent is valid: feature off
  if (typeof cfg !== "object") return "watchdog must be an object";
  const c = cfg as Partial<WatchdogConfig>;
  if (typeof c.key !== "string" || c.key.length === 0) return "watchdog.key is required";
  if (!controllable[c.key]) {
    return `watchdog.key '${c.key}' is not in the profile's controllable map`;
  }
  if (typeof c.value !== "number" || !Number.isFinite(c.value)) {
    return "watchdog.value must be a number";
  }
  const def = controllable[c.key];
  if (c.value < def.min || c.value > def.max) {
    return `watchdog.value ${c.value} is outside '${c.key}' range [${def.min}..${def.max}]`;
  }
  if (typeof c.deviceTimeoutMs !== "number" || c.deviceTimeoutMs <= 0) {
    return "watchdog.deviceTimeoutMs must be a positive number of milliseconds";
  }
  if (typeof c.intervalMs !== "number" || c.intervalMs <= 0) {
    return "watchdog.intervalMs must be a positive number of milliseconds";
  }
  // The whole point is to refresh faster than the device gives up. A config
  // that refreshes slower would make the device revert DURING normal
  // operation — the opposite of the intent, and worse than no watchdog.
  if (c.intervalMs >= c.deviceTimeoutMs) {
    return `watchdog.intervalMs (${c.intervalMs}) must be shorter than deviceTimeoutMs (${c.deviceTimeoutMs})`;
  }
  return null;
}

/**
 * The interval actually used. A configured interval is honoured only while it
 * stays comfortably inside the device's timeout; otherwise the timeout wins.
 * Configuration cannot make the watchdog useless.
 */
export function effectiveIntervalMs(cfg: WatchdogConfig): number {
  const safe = Math.floor(cfg.deviceTimeoutMs / REFRESHES_PER_TIMEOUT);
  return Math.max(MIN_INTERVAL_MS, Math.min(cfg.intervalMs, safe));
}

/** Is a refresh due? `lastAt` is null when this meter has never been refreshed. */
export function watchdogDue(lastAt: number | null, nowMs: number, intervalMs: number): boolean {
  if (lastAt === null) return true; // first refresh: immediately
  return nowMs - lastAt >= intervalMs;
}

/**
 * Will the controller's own tick keep up with this watchdog?
 *
 * A watchdog needing a refresh every 5 s cannot be served by a loop that runs
 * every 30 s: the device would revert between ticks, repeatedly. Surfacing it
 * as a startup warning is the only honest option — silently refreshing too
 * slowly looks like it works until the day it matters.
 */
export function tickTooSlow(cfg: WatchdogConfig, tickMs: number): boolean {
  return tickMs > effectiveIntervalMs(cfg);
}
