// Setpoint deadman logic. The property that matters: a device must never be
// left holding a setpoint after the controller stops refreshing, and
// configuration must not be able to make the watchdog useless.
import { describe, test, expect } from "vitest";
import {
  MIN_INTERVAL_MS,
  REFRESHES_PER_TIMEOUT,
  effectiveIntervalMs,
  tickTooSlow,
  validateWatchdog,
  watchdogDue,
  type WatchdogConfig,
} from "./watchdog";
import type { ControllableMap } from "../control/execute";

const controllable: ControllableMap = {
  batteryPowerKw: { address: 41000, min: -500, max: 500, scale: 10 },
  heartbeat: { address: 41010, min: 0, max: 1 },
};

const cfg = (over: Partial<WatchdogConfig> = {}): WatchdogConfig => ({
  key: "heartbeat",
  value: 1,
  intervalMs: 5_000,
  deviceTimeoutMs: 30_000,
  ...over,
});

describe("validateWatchdog", () => {
  test("absent configuration is valid — the feature is simply off", () => {
    expect(validateWatchdog(null, controllable)).toBeNull();
    expect(validateWatchdog(undefined, controllable)).toBeNull();
  });

  test("a well-formed block passes", () => {
    expect(validateWatchdog(cfg(), controllable)).toBeNull();
  });

  test("the key must be a register the profile already allows writing", () => {
    // Otherwise the watchdog would be a second write path that bypasses the
    // controllable whitelist.
    expect(validateWatchdog(cfg({ key: "notAKey" }), controllable)).toMatch(/controllable map/);
  });

  test("the value must sit inside that register's declared range", () => {
    expect(validateWatchdog(cfg({ value: 7 }), controllable)).toMatch(/outside/);
  });

  test("refreshing slower than the device gives up is rejected", () => {
    // This is the dangerous misconfiguration: the device would revert during
    // NORMAL operation, which is worse than having no watchdog at all.
    expect(validateWatchdog(cfg({ intervalMs: 30_000 }), controllable)).toMatch(/shorter than/);
    expect(validateWatchdog(cfg({ intervalMs: 45_000 }), controllable)).toMatch(/shorter than/);
  });

  test("missing or nonsense fields are reported, not silently defaulted", () => {
    expect(validateWatchdog({}, controllable)).toMatch(/key/);
    expect(validateWatchdog(cfg({ value: undefined }), controllable)).toMatch(/value/);
    expect(validateWatchdog(cfg({ deviceTimeoutMs: 0 }), controllable)).toMatch(/deviceTimeoutMs/);
    expect(validateWatchdog(cfg({ intervalMs: -1 }), controllable)).toMatch(/intervalMs/);
    expect(validateWatchdog("nope", controllable)).toMatch(/object/);
  });
});

describe("effectiveIntervalMs", () => {
  test("a sensible configured interval is honoured", () => {
    expect(effectiveIntervalMs(cfg({ intervalMs: 5_000, deviceTimeoutMs: 30_000 }))).toBe(5_000);
  });

  test("an interval too close to the timeout is tightened, not trusted", () => {
    // 25s configured against a 30s timeout leaves no room for a lost refresh.
    const got = effectiveIntervalMs(cfg({ intervalMs: 25_000, deviceTimeoutMs: 30_000 }));
    expect(got).toBe(Math.floor(30_000 / REFRESHES_PER_TIMEOUT));
    expect(got).toBeLessThan(25_000);
  });

  test("at least two refreshes may be lost before the device gives up", () => {
    const c = cfg({ intervalMs: 60_000, deviceTimeoutMs: 30_000 });
    expect(effectiveIntervalMs(c) * REFRESHES_PER_TIMEOUT).toBeLessThanOrEqual(c.deviceTimeoutMs);
  });

  test("a floor stops a tiny timeout from hammering the bus", () => {
    expect(effectiveIntervalMs(cfg({ intervalMs: 1, deviceTimeoutMs: 900 }))).toBe(MIN_INTERVAL_MS);
  });
});

describe("watchdogDue", () => {
  test("a device never refreshed is due immediately", () => {
    expect(watchdogDue(null, 1_000, 5_000)).toBe(true);
  });

  test("due exactly on the boundary, not a tick later", () => {
    expect(watchdogDue(0, 4_999, 5_000)).toBe(false);
    expect(watchdogDue(0, 5_000, 5_000)).toBe(true);
  });
});

describe("tickTooSlow", () => {
  test("a controller tick slower than the refresh interval is flagged", () => {
    // A 30s loop cannot serve a watchdog that must be fed every 5s: the device
    // would revert between ticks, over and over.
    expect(tickTooSlow(cfg({ intervalMs: 5_000, deviceTimeoutMs: 30_000 }), 30_000)).toBe(true);
  });

  test("a fast enough tick is not flagged", () => {
    expect(tickTooSlow(cfg({ intervalMs: 10_000, deviceTimeoutMs: 60_000 }), 5_000)).toBe(false);
  });
});
