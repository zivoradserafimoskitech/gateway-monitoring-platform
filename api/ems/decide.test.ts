// Unit tests for the pure EMS decision functions (v10/P1-9).
// Extracted unchanged from controller.ts — these pin the documented behavior:
// key preference, SOC guards, schedule windows (incl. midnight wrap),
// peak-shaving hysteresis + min-move, and the plan step function.
import { test } from "vitest";
import assert from "node:assert/strict";
import type { EmsSchedule } from "@db/schema";
import type { ControllableDef, ControllableMap } from "../control/execute";
import {
  kwToMode,
  localClock,
  peakHoldPower,
  peakMinMoveKw,
  peakRetrimDue,
  peakStartPower,
  peakStopDue,
  pickSetpointKey,
  planKwAt,
  scheduleDue,
  setpointValue,
  socGuardBlocks,
} from "./decide";

const def = (over: Partial<ControllableDef> = {}): ControllableDef => ({ address: 1, min: 0, max: 100, ...over });

const sched = (over: Partial<EmsSchedule>): EmsSchedule =>
  ({
    id: 1,
    meterId: 1,
    name: "s",
    dayOfWeekMask: 0b1111111,
    startMin: 0,
    endMin: 0,
    mode: "discharge",
    targetKw: null,
    targetSoc: null,
    enabled: true,
    createdBy: null,
    orgId: null,
    createdAt: new Date(0),
    ...over,
  }) as EmsSchedule;

// ─── pickSetpointKey ─────────────────────────────────────────────────────────
test("pickSetpointKey: per-mode preference order wins", () => {
  const map: ControllableMap = {
    activePowerKw: def({ address: 3 }),
    chargeDischargePowerKw: def({ address: 2 }),
    dischargePowerKw: def({ address: 1 }),
  };
  assert.equal(pickSetpointKey(map, "discharge")?.key, "dischargePowerKw");
  assert.equal(pickSetpointKey(map, "charge")?.key, "chargeDischargePowerKw"); // no chargePowerKw declared
  assert.equal(pickSetpointKey(map, "idle")?.key, "dischargePowerKw");
});

test("pickSetpointKey: falls back to the first declared key; null on empty map", () => {
  const only: ControllableMap = { weirdRegister: def({ address: 9 }) };
  assert.equal(pickSetpointKey(only, "discharge")?.key, "weirdRegister");
  assert.equal(pickSetpointKey({}, "discharge"), null);
});

// ─── setpointValue ───────────────────────────────────────────────────────────
test("setpointValue: idle is always 0, even on a bipolar register", () => {
  assert.equal(setpointValue("idle", def({ min: -100, max: 100 }), 40), 0);
  assert.equal(setpointValue("idle", def(), null), 0);
});

test("setpointValue: discharge is +target; null target = register max", () => {
  assert.equal(setpointValue("discharge", def({ max: 100 }), 40), 40);
  assert.equal(setpointValue("discharge", def({ max: 100 }), null), 100);
});

test("setpointValue: charge is negative only on a bipolar register", () => {
  assert.equal(setpointValue("charge", def({ min: -100, max: 100 }), 40), -40);
  assert.equal(setpointValue("charge", def({ min: 0, max: 100 }), 40), 40); // dedicated charge register
  assert.equal(setpointValue("charge", def({ min: -50, max: 50 }), null), -50);
});

// ─── localClock / scheduleDue ────────────────────────────────────────────────
test("localClock: UTC identity and IANA offset (Europe/Skopje summer +2)", () => {
  const now = new Date("2026-08-13T22:30:00Z"); // Thursday
  assert.deepEqual(localClock("UTC", now), { dow: 4, min: 22 * 60 + 30 });
  assert.deepEqual(localClock("Europe/Skopje", now), { dow: 5, min: 30 }); // 00:30 Friday local
});

test("localClock: DST-correct winter offset (Europe/Skopje winter +1)", () => {
  const now = new Date("2026-01-15T23:30:00Z");
  assert.deepEqual(localClock("Europe/Skopje", now), { dow: 5, min: 30 }); // 00:30 next day local
});

test("scheduleDue: weekday bit must be set", () => {
  const s = sched({ dayOfWeekMask: 0b0000010, startMin: 60, endMin: 120 }); // Monday only
  assert.equal(scheduleDue(s, 1, 90), true);
  assert.equal(scheduleDue(s, 2, 90), false);
});

test("scheduleDue: start == end means all day", () => {
  const s = sched({ startMin: 0, endMin: 0 });
  assert.equal(scheduleDue(s, 3, 0), true);
  assert.equal(scheduleDue(s, 3, 1439), true);
});

test("scheduleDue: normal window is [start, end)", () => {
  const s = sched({ startMin: 480, endMin: 600 }); // 08:00–10:00
  assert.equal(scheduleDue(s, 3, 479), false);
  assert.equal(scheduleDue(s, 3, 480), true);
  assert.equal(scheduleDue(s, 3, 599), true);
  assert.equal(scheduleDue(s, 3, 600), false);
});

test("scheduleDue: window with start > end wraps midnight", () => {
  const s = sched({ startMin: 1320, endMin: 120 }); // 22:00–02:00
  assert.equal(scheduleDue(s, 3, 1320), true);
  assert.equal(scheduleDue(s, 3, 1439), true);
  assert.equal(scheduleDue(s, 3, 0), true);
  assert.equal(scheduleDue(s, 3, 119), true);
  assert.equal(scheduleDue(s, 3, 120), false);
  assert.equal(scheduleDue(s, 3, 1319), false);
});

// ─── socGuardBlocks ──────────────────────────────────────────────────────────
test("socGuardBlocks: discharge blocked at/below target, allowed above", () => {
  assert.equal(socGuardBlocks("discharge", 20, 20), true); // at → blocked
  assert.equal(socGuardBlocks("discharge", 19.9, 20), true);
  assert.equal(socGuardBlocks("discharge", 20.1, 20), false);
});

test("socGuardBlocks: charge blocked at/above target, allowed below", () => {
  assert.equal(socGuardBlocks("charge", 80, 80), true); // at → blocked
  assert.equal(socGuardBlocks("charge", 80.1, 80), true);
  assert.equal(socGuardBlocks("charge", 79.9, 80), false);
});

test("socGuardBlocks: vacuous for idle, missing SOC, or no target", () => {
  assert.equal(socGuardBlocks("idle", 10, 20), false);
  assert.equal(socGuardBlocks("discharge", null, 20), false);
  assert.equal(socGuardBlocks("discharge", undefined, 20), false);
  assert.equal(socGuardBlocks("discharge", 5, null), false); // plans carry no targetSoc
});

// ─── peak shaving ────────────────────────────────────────────────────────────
test("peakStopDue: strictly below threshold − hysteresis", () => {
  assert.equal(peakStopDue(89.9, 100, 10), true);
  assert.equal(peakStopDue(90, 100, 10), false); // at the line → still riding
  assert.equal(peakStopDue(101, 100, 10), false);
  assert.equal(peakStopDue(99, 100, 0), true); // zero hysteresis
});

test("peakStartPower: min(import − threshold, maxDischarge, register max)", () => {
  assert.equal(peakStartPower(130, 100, 50, 100), 30); // excess is the binding constraint
  assert.equal(peakStartPower(500, 100, 50, 100), 50); // configured cap binds
  assert.equal(peakStartPower(500, 100, 500, 40), 40); // register max binds
  assert.ok(peakStartPower(90, 100, 50, 100) <= 0); // below threshold → caller skips
});

test("peakHoldPower: same caps, floored at 0", () => {
  assert.equal(peakHoldPower(130, 100, 50, 100), 30);
  assert.equal(peakHoldPower(95, 100, 50, 100), 0); // dipped below threshold, not yet stop-due
});

test("peakMinMoveKw: 10% of maxDischarge with a 1 kW floor", () => {
  assert.equal(peakMinMoveKw(50), 5);
  assert.equal(peakMinMoveKw(5), 1); // floor
  assert.equal(peakMinMoveKw(100), 10);
});

test("peakRetrimDue: first send always; then only on ≥ min-move", () => {
  assert.equal(peakRetrimDue(30, null, 5), true);
  assert.equal(peakRetrimDue(35, 30, 5), true); // exactly at the delta
  assert.equal(peakRetrimDue(34.9, 30, 5), false);
  assert.equal(peakRetrimDue(25, 30, 5), true); // downward moves count too
});

// ─── plans ───────────────────────────────────────────────────────────────────
test("planKwAt: step function — kw of the last setpoint with ts ≤ now", () => {
  const sps = [
    { ts: "2026-08-13T10:00:00Z", kw: 10 },
    { ts: "2026-08-13T11:00:00Z", kw: -20 },
    { ts: "2026-08-13T12:00:00Z", kw: 0 },
  ];
  const at = (iso: string) => Date.parse(iso);
  assert.equal(planKwAt(sps, at("2026-08-13T09:59:59Z")), null); // none due yet
  assert.equal(planKwAt(sps, at("2026-08-13T10:00:00Z")), 10); // exact boundary
  assert.equal(planKwAt(sps, at("2026-08-13T10:59:59Z")), 10); // holds the step
  assert.equal(planKwAt(sps, at("2026-08-13T11:30:00Z")), -20);
  assert.equal(planKwAt(sps, at("2026-08-13T23:00:00Z")), 0);
  assert.equal(planKwAt([], at("2026-08-13T10:00:00Z")), null);
});

test("kwToMode: sign mapping", () => {
  assert.equal(kwToMode(10), "discharge");
  assert.equal(kwToMode(-10), "charge");
  assert.equal(kwToMode(0), "idle");
});
