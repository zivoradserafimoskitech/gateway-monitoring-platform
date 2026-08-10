// Unit tests for poller scheduling helpers (v5 #10–#12).
import { test } from "vitest";
import assert from "node:assert/strict";
import { nextBackoffMs, isTransportError, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "../api/poller/backoff";
import { offlineThresholdMs, MIN_OFFLINE_AFTER_MS } from "../api/mqtt/offline";

test("nextBackoffMs: exponential from base, capped at max", () => {
  assert.equal(nextBackoffMs(0), BACKOFF_BASE_MS);
  assert.equal(nextBackoffMs(10_000), 20_000);
  assert.equal(nextBackoffMs(160_000), 300_000); // cap
  assert.equal(nextBackoffMs(BACKOFF_MAX_MS), BACKOFF_MAX_MS);
});

test("isTransportError: socket-level errors qualify", () => {
  assert.ok(isTransportError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
  assert.ok(isTransportError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })));
  assert.ok(isTransportError(new Error("Port Not Open")));
});

test("isTransportError: device-level errors do NOT kill the shared socket", () => {
  assert.ok(!isTransportError(new Error("Modbus exception 2: Illegal data address")));
  assert.ok(!isTransportError(new Error("Timed out"))); // one dead unit ≠ dead socket
  assert.ok(!isTransportError(new Error("no register map for model 'x'")));
  assert.ok(!isTransportError(null));
});

test("offlineThresholdMs: 2.5x poll interval with 120s floor (#2)", () => {
  assert.equal(offlineThresholdMs(60), 150_000); // 60s → 150s
  assert.equal(offlineThresholdMs(5), MIN_OFFLINE_AFTER_MS); // floor
  assert.equal(offlineThresholdMs(3600), 9_000_000); // 1h interval → 2.5h
  assert.equal(offlineThresholdMs(null), 150_000); // default 60s
  assert.equal(offlineThresholdMs(undefined), 150_000);
});
