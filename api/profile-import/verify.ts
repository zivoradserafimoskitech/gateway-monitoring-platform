// Wave 5 / T3: bench verification workflow — PURE logic.
//
// This module holds everything the guided wizard (Settings → Device profiles →
// Verify) and the profiles.verify* endpoints need that does NOT touch the bus
// or the DB, so it can be unit-tested standalone:
//
//  1. Read-verification flags (step 1): per-key plausibility heuristics on
//     live-decoded values — declared min/max violations plus scaling-error
//     smells (SoC > 100 %, voltage > 1000 V, power beyond the nameplate).
//  2. Wizard step gating: which of the 4 steps (read → sign → control →
//     range) is available/done, and whether completion may be offered.
//
// Sign convention (step 2) is THE safety-critical record: vendors disagree
// whether batteryPowerKw reads positive or negative while discharging, and
// getting it backwards means the optimiser charges at the evening peak while
// believing it is discharging — plausible on every dashboard, and expensive.

import type { ControllableMap } from "../control/execute";

export type VerifyFlag = "out_of_range" | "implausible_soc" | "implausible_voltage" | "beyond_nameplate";

/** One live-decoded register value, with the declared bounds from the map. */
export interface VerifyReadRow {
  key: string;
  unit?: string;
  /** Declared plausibility bounds on the SCALED value (from registerMap / CSV min/max). */
  min?: number;
  max?: number;
  /** Scaled live value (raw × scale + offset); undefined when the read failed. */
  value?: number;
}

const isSocKey = (key: string): boolean => /soc/i.test(key) && /percent|pct|%/i.test(key);
const isVoltageKey = (key: string, unit?: string): boolean => /volt/i.test(key) || unit === "V";
const isPowerKey = (key: string, unit?: string): boolean => /power/i.test(key) || unit === "kW" || unit === "W";

/** |min|,|max| envelope across controllable power setpoints — the nameplate. */
export function nameplateAbsMax(controllable: ControllableMap | null | undefined): number | undefined {
  if (!controllable) return undefined;
  let out: number | undefined;
  for (const [key, def] of Object.entries(controllable)) {
    if (!isPowerKey(key, def.unit)) continue;
    const bound = Math.max(Math.abs(def.min), Math.abs(def.max));
    out = out === undefined ? bound : Math.max(out, bound);
  }
  return out;
}

/** True when the profile has a controllable power setpoint — those profiles
 *  MUST record the sign convention before they can become bench_verified. */
export function hasPowerSetpoint(controllable: ControllableMap | null | undefined): boolean {
  return nameplateAbsMax(controllable) !== undefined;
}

/**
 * Plausibility flags for one live value. Pure heuristic — a flag means
 * "operator, look at this", not "the map is wrong".
 */
export function computeReadFlags(row: VerifyReadRow, nameplate?: number): VerifyFlag[] {
  const flags: VerifyFlag[] = [];
  const v = row.value;
  if (v === undefined || !Number.isFinite(v)) return flags;
  if ((row.min !== undefined && v < row.min) || (row.max !== undefined && v > row.max)) {
    flags.push("out_of_range");
  }
  if (isSocKey(row.key) && (v > 100 || v < 0)) flags.push("implausible_soc");
  if (isVoltageKey(row.key, row.unit) && Math.abs(v) > 1000) flags.push("implausible_voltage");
  if (isPowerKey(row.key, row.unit) && nameplate !== undefined && Math.abs(v) > nameplate) {
    flags.push("beyond_nameplate");
  }
  return flags;
}

// ─── Wizard step gating ─────────────────────────────────────────────────────

export type BenchStepId = "read" | "sign" | "control" | "range";

export interface BenchStepState {
  id: BenchStepId;
  /** Available = previous steps are done (wizard order is enforced). */
  available: boolean;
  done: boolean;
}

/** Persisted/recorded progress the gating function reasons about. */
export interface BenchProgress {
  /** Step 1: operator confirmed the live read table is plausible. */
  readConfirmed: boolean;
  /** Step 2: dischargePositive recorded on the profile (null = never). */
  dischargePositive: boolean | null;
  /** Step 3: writable keys with a successful write + read-back round-trip. */
  roundTripsOk: string[];
  /** Step 4: operator confirmed min/max match the nameplate. */
  rangeConfirmed: boolean;
}

/**
 * Compute the wizard state. Steps are strictly sequential:
 *   read → sign (skipped when no power setpoint) → control (needs every
 *   writable key round-tripped; no writable keys = trivially done) → range
 *   (skipped when there are no writable bounds to confirm) → completable.
 */
export function benchStepStates(
  opts: { controllable: ControllableMap | null | undefined },
  progress: BenchProgress,
): { steps: BenchStepState[]; completable: boolean } {
  const writableKeys = Object.keys(opts.controllable ?? {});
  const needsSign = hasPowerSetpoint(opts.controllable);
  const readDone = progress.readConfirmed;
  const signDone = !needsSign || progress.dischargePositive !== null;
  const controlDone = writableKeys.every((k) => progress.roundTripsOk.includes(k));
  const rangeNeeded = writableKeys.length > 0;
  const rangeDone = !rangeNeeded || progress.rangeConfirmed;

  const steps: BenchStepState[] = [
    { id: "read", available: true, done: readDone },
    { id: "sign", available: readDone, done: signDone },
    { id: "control", available: readDone && signDone, done: controlDone },
    { id: "range", available: readDone && signDone && controlDone, done: rangeDone },
  ];
  return { steps, completable: readDone && signDone && controlDone && rangeDone };
}
