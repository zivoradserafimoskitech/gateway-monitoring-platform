// Unit tests for G30 value normalization (v5 #9): profile unit metadata
// decides W→kW conversion; the magnitude heuristic is only a fallback.
// v6/R8: open-key passthrough makes MQTT usable for PV/BESS telemetry.
import { test } from "vitest";
import assert from "node:assert/strict";
import { normalizeValues } from "../api/mqtt/handlers";

test("unit hint kW: value passes through unconverted even when large", () => {
  const hints = new Map([["activePowerKw", "kW"]]);
  // 6 MW site expressed in kW — the old heuristic would have divided by 1000
  const out = normalizeValues({ activePowerKw: 6000 }, hints);
  assert.equal(out.activePowerKw, 6000);
});

test("unit hint W: always converts, even below the heuristic threshold", () => {
  const hints = new Map([["activePowerKw", "W"]]);
  const out = normalizeValues({ activePowerKw: 800 }, hints);
  assert.equal(out.activePowerKw, 0.8);
});

test("no hint: magnitude heuristic fallback preserved", () => {
  const big = normalizeValues({ activePowerKw: 12500 });
  assert.equal(big.activePowerKw, 12.5);
  const small = normalizeValues({ activePowerKw: 3.2 });
  assert.equal(small.activePowerKw, 3.2);
});

test("aliases and string numbers still parse", () => {
  const out = normalizeValues({ U1: "231.5", P: 7.5 });
  assert.equal(out.voltageL1, 231.5);
  assert.equal(out.activePowerKw, 7.5);
});

// ─── v6/R8: open-key passthrough (PV / BESS / weather over MQTT JSON) ───────

test("open keys from the profile register map pass through", () => {
  const hints = new Map([
    ["socPercent", "%"],
    ["energyTotalKwh", "kWh"],
  ]);
  const out = normalizeValues(
    { socPercent: 87.5, energyTotalKwh: 15234.2 },
    hints,
    ["socPercent", "energyTotalKwh"],
  );
  assert.equal(out.socPercent, 87.5);
  assert.equal(out.energyTotalKwh, 15234.2);
});

test("open key with W-class hint converts to kW-class by key name", () => {
  const hints = new Map([
    ["dcPowerKw", "W"],
    ["batteryPowerKw", "W"],
    ["chargeEnergyTotalKwh", "Wh"],
  ]);
  const out = normalizeValues(
    { dcPowerKw: 42300, batteryPowerKw: -2600, chargeEnergyTotalKwh: 987654 },
    hints,
    ["dcPowerKw", "batteryPowerKw", "chargeEnergyTotalKwh"],
  );
  assert.equal(out.dcPowerKw, 42.3);
  assert.equal(out.batteryPowerKw, -2.6);
  assert.equal(out.chargeEnergyTotalKwh, 987.654);
});

test("open key already in kW-class units passes through unconverted", () => {
  const hints = new Map([["dcPowerKw", "kW"]]);
  const out = normalizeValues({ dcPowerKw: 42.3 }, hints, ["dcPowerKw"]);
  assert.equal(out.dcPowerKw, 42.3);
});

test("keys not in extraKeys are still dropped (no wildcard ingestion)", () => {
  const out = normalizeValues({ socPercent: 50, hackerKey: 1 }, undefined, ["socPercent"]);
  assert.equal(out.socPercent, 50);
  assert.equal("hackerKey" in out, false);
});

test("alias-mapped metrics win over open keys on collision", () => {
  const hints = new Map([["activePowerKw", "kW"]]);
  // Canonical key present: pickNumber prefers it (first alias).
  const direct = normalizeValues({ P: 7.5, activePowerKw: 9 }, hints, ["activePowerKw"]);
  assert.equal(direct.activePowerKw, 9);
  // Only alias present: alias mapping fills the key, open-key pass skips it.
  const aliased = normalizeValues({ P: 7.5 }, hints, ["activePowerKw"]);
  assert.equal(aliased.activePowerKw, 7.5);
});
