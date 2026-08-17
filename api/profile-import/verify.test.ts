// Wave 5 / T3: unit tests for the PURE bench-verification logic —
// read-verification flag heuristics and the wizard step gating.
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  benchStepStates,
  computeReadFlags,
  hasPowerSetpoint,
  nameplateAbsMax,
} from "./verify";

const POWER_SETPOINT = { activePowerSetpointKw: { address: 13051, min: -100, max: 100, scale: 10, unit: "kW" } };

// ─── computeReadFlags ───────────────────────────────────────────────────────

test("flags: value inside declared min/max → no out_of_range", () => {
  assert.deepEqual(computeReadFlags({ key: "socPercent", unit: "%", min: 0, max: 100, value: 55 }), []);
});

test("flags: value outside declared min/max → out_of_range", () => {
  assert.deepEqual(computeReadFlags({ key: "cellTempMaxC", unit: "C", min: -20, max: 60, value: 75 }), ["out_of_range"]);
  assert.deepEqual(computeReadFlags({ key: "cellTempMaxC", unit: "C", min: -20, max: 60, value: -30 }), ["out_of_range"]);
});

test("flags: socPercent > 100 → implausible_soc (+ out_of_range when bounds declared)", () => {
  const flags = computeReadFlags({ key: "socPercent", unit: "%", min: 0, max: 100, value: 6553.5 });
  assert.ok(flags.includes("implausible_soc"));
  assert.ok(flags.includes("out_of_range"));
  // negative SoC is equally impossible
  assert.ok(computeReadFlags({ key: "socPercent", value: -3 }).includes("implausible_soc"));
});

test("flags: voltage-ish key > 1000 → implausible_voltage", () => {
  assert.ok(computeReadFlags({ key: "dcVoltage", unit: "V", value: 6553 }).includes("implausible_voltage"));
  assert.ok(computeReadFlags({ key: "voltageL1", value: 1200 }).includes("implausible_voltage"));
  assert.deepEqual(computeReadFlags({ key: "voltageL1", unit: "V", value: 400 }), []);
  // a temperature with a V-shaped key name must not be flagged
  assert.deepEqual(computeReadFlags({ key: "socPercent", unit: "%", value: 1200 }).filter((f) => f === "implausible_voltage"), []);
});

test("flags: power beyond declared nameplate → beyond_nameplate", () => {
  const nameplate = nameplateAbsMax(POWER_SETPOINT);
  assert.equal(nameplate, 100);
  assert.ok(computeReadFlags({ key: "batteryPowerKw", unit: "kW", value: 150 }, nameplate).includes("beyond_nameplate"));
  assert.deepEqual(computeReadFlags({ key: "batteryPowerKw", unit: "kW", value: -100 }, nameplate), []);
  // no nameplate declared → heuristic stays silent
  assert.deepEqual(computeReadFlags({ key: "batteryPowerKw", unit: "kW", value: 9999 }, undefined), []);
});

test("flags: failed read (no value) → no flags", () => {
  assert.deepEqual(computeReadFlags({ key: "socPercent", min: 0, max: 100 }), []);
});

// ─── nameplateAbsMax / hasPowerSetpoint ─────────────────────────────────────

test("nameplateAbsMax: only power-key controllables count; envelope of |min|,|max|", () => {
  assert.equal(nameplateAbsMax({ modeRegister: { address: 1, min: 0, max: 3 } }), undefined);
  assert.equal(
    nameplateAbsMax({
      chargeLimitKw: { address: 1, min: 0, max: 50, unit: "kW" },
      activePowerSetpointKw: { address: 2, min: -100, max: 100, unit: "kW" },
    }),
    100,
  );
  assert.equal(hasPowerSetpoint(POWER_SETPOINT), true);
  assert.equal(hasPowerSetpoint({ modeRegister: { address: 1, min: 0, max: 3 } }), false);
  assert.equal(hasPowerSetpoint(null), false);
});

// ─── benchStepStates (wizard gating) ────────────────────────────────────────

const NO_PROGRESS = { readConfirmed: false, dischargePositive: null, roundTripsOk: [], rangeConfirmed: false };

test("gating: nothing done → only step 1 available, not completable", () => {
  const { steps, completable } = benchStepStates({ controllable: POWER_SETPOINT }, NO_PROGRESS);
  assert.deepEqual(
    steps.map((s) => [s.id, s.available, s.done]),
    [
      ["read", true, false],
      ["sign", false, false],
      ["control", false, false],
      ["range", false, false],
    ],
  );
  assert.equal(completable, false);
});

test("gating: strict sequence — control unavailable until sign recorded, range until control done", () => {
  const afterRead = benchStepStates(
    { controllable: POWER_SETPOINT },
    { ...NO_PROGRESS, readConfirmed: true },
  );
  assert.equal(afterRead.steps[1].available, true); // sign
  assert.equal(afterRead.steps[2].available, false); // control locked
  assert.equal(afterRead.completable, false);

  const afterSign = benchStepStates(
    { controllable: POWER_SETPOINT },
    { ...NO_PROGRESS, readConfirmed: true, dischargePositive: true },
  );
  assert.equal(afterSign.steps[2].available, true);
  assert.equal(afterSign.steps[2].done, false); // round-trip still missing
  assert.equal(afterSign.steps[3].available, false);

  const full = benchStepStates(
    { controllable: POWER_SETPOINT },
    { readConfirmed: true, dischargePositive: false, roundTripsOk: ["activePowerSetpointKw"], rangeConfirmed: true },
  );
  assert.equal(full.completable, true);
  assert.ok(full.steps.every((s) => s.done));
});

test("gating: profile WITHOUT a power setpoint skips the sign step", () => {
  const { steps, completable } = benchStepStates(
    { controllable: { modeRegister: { address: 1, min: 0, max: 3 } } },
    { ...NO_PROGRESS, readConfirmed: true, roundTripsOk: ["modeRegister"], rangeConfirmed: true },
  );
  assert.equal(steps[1].done, true); // sign trivially done
  assert.equal(completable, true);
});

test("gating: profile with no writable keys — control trivially done, range not needed", () => {
  const { steps, completable } = benchStepStates(
    { controllable: null },
    { ...NO_PROGRESS, readConfirmed: true },
  );
  assert.equal(steps[2].done, true);
  assert.equal(steps[3].done, true);
  assert.equal(completable, true);
});

test("gating: multiple writable keys need ALL round-tripped", () => {
  const ctrl = {
    activePowerSetpointKw: { address: 1, min: -100, max: 100, unit: "kW" },
    modeRegister: { address: 2, min: 0, max: 3 },
  };
  const partial = benchStepStates(
    { controllable: ctrl },
    { readConfirmed: true, dischargePositive: true, roundTripsOk: ["modeRegister"], rangeConfirmed: true },
  );
  assert.equal(partial.steps[2].done, false);
  assert.equal(partial.completable, false);
});
