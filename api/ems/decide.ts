// v10/P1-9: pure EMS decision functions, mechanically extracted from
// controller.ts so they can be unit-tested without a database. No behavior
// change — controller.ts calls these and re-exports the ones that were
// already part of its public surface.
import type { EmsSchedule } from "@db/schema";
import type { ControllableDef, ControllableMap } from "../control/execute";
import { tzOffsetMs } from "../lib/tz";

// ─── Setpoint key selection ─────────────────────────────────────────────────
// BESS profiles declare writable registers in device_profiles.controllable.
// Preferred keys per mode; fall back to the first declared key so any
// single-register BESS still works.
const KEY_PREF: Record<"charge" | "discharge" | "idle", string[]> = {
  discharge: ["dischargePowerKw", "chargeDischargePowerKw", "activePowerKw"],
  charge: ["chargePowerKw", "chargeDischargePowerKw", "activePowerKw"],
  idle: ["dischargePowerKw", "chargeDischargePowerKw", "activePowerKw"],
};

export type EmsMode = "charge" | "discharge" | "idle";

export function pickSetpointKey(map: ControllableMap, mode: EmsMode): { key: string; def: ControllableDef } | null {
  for (const k of KEY_PREF[mode]) {
    if (map[k]) return { key: k, def: map[k] };
  }
  const first = Object.entries(map)[0];
  return first ? { key: first[0], def: first[1] } : null;
}

/** Setpoint value for a mode: idle → 0; charge → −t when the register is bipolar, else +t (dedicated charge register). */
export function setpointValue(mode: EmsMode, def: ControllableDef, targetKw: number | null): number {
  if (mode === "idle") return 0;
  const t = targetKw ?? def.max;
  return mode === "charge" && def.min < 0 ? -t : t;
}

// ─── Schedule windows ────────────────────────────────────────────────────────
/** Local weekday (0=Sunday) and minutes-from-midnight for an instant in a zone. */
export function localClock(tz: string, now: Date): { dow: number; min: number } {
  const local = new Date(now.getTime() + tzOffsetMs(tz, now));
  return { dow: local.getUTCDay(), min: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

export function scheduleDue(s: EmsSchedule, dow: number, min: number): boolean {
  if (((s.dayOfWeekMask >> dow) & 1) === 0) return false;
  if (s.startMin === s.endMin) return true; // 00:00–00:00 = all day
  if (s.startMin < s.endMin) return min >= s.startMin && min < s.endMin;
  return min >= s.startMin || min < s.endMin; // wraps midnight
}

// ─── Fail-closed SoC guard (audit wave 6) ────────────────────────────────────
// Replaces the old fail-open socGuardBlocks (removed, no alias). The old guard
// returned "not blocked" when SoC was unknown — a BESS could be discharged
// below its safe minimum while telemetry was down. The new guard FAILS CLOSED:
// once at least one SoC limit is configured, an unknown (missing or stale, see
// freshForControl) SoC BLOCKS charge/discharge.
export interface SocLimits {
  minSoc: number | null;
  maxSoc: number | null;
}

export interface SocGuardResult {
  blocked: boolean;
  reason: string | null;
}

/**
 * SoC guard decision. Rules (exact):
 *  1. idle → never blocked (vacuous).
 *  2. no limits configured (both null) → never blocked — unchanged legacy
 *     behavior for schedules without targetSoc and plans without min/maxSoc.
 *  3. at least one limit configured + soc unknown → BLOCKED (fail-closed).
 *  4. discharge with soc <= minSoc → BLOCKED (boundary inclusive).
 *  5. charge with soc >= maxSoc → BLOCKED (boundary inclusive).
 *  6. otherwise → not blocked.
 * Schedules map targetSoc → { minSoc: targetSoc, maxSoc: targetSoc } (same
 * at/under and at/above semantics as the legacy guard, plus rule 3).
 */
export function socGuardDecision(
  mode: EmsMode,
  soc: number | null | undefined,
  limits: SocLimits,
): SocGuardResult {
  if (mode === "idle") return { blocked: false, reason: null };
  const { minSoc, maxSoc } = limits;
  if (minSoc == null && maxSoc == null) return { blocked: false, reason: null };
  if (soc == null) return { blocked: true, reason: "soc unknown (fail-closed)" };
  if (mode === "discharge" && minSoc != null && soc <= minSoc) {
    return { blocked: true, reason: `soc ${soc}% <= min ${minSoc}%` };
  }
  if (mode === "charge" && maxSoc != null && soc >= maxSoc) {
    return { blocked: true, reason: `soc ${soc}% >= max ${maxSoc}%` };
  }
  return { blocked: false, reason: null };
}

// ─── Peak shaving ────────────────────────────────────────────────────────────
/** Stop condition while a peak event is active: import dropped below threshold − hysteresis. */
export function peakStopDue(importKw: number, thresholdKw: number, hysteresisKw: number): boolean {
  return importKw < thresholdKw - hysteresisKw;
}

/** Discharge power when a peak event starts: min(import − threshold, maxDischargeKw, register max). */
export function peakStartPower(importKw: number, thresholdKw: number, maxDischargeKw: number, registerMax: number): number {
  return Math.min(importKw - thresholdKw, maxDischargeKw, registerMax);
}

/** Discharge power while riding an active peak event (floored at 0). */
export function peakHoldPower(importKw: number, thresholdKw: number, maxDischargeKw: number, registerMax: number): number {
  return Math.min(Math.max(importKw - thresholdKw, 0), maxDischargeKw, registerMax);
}

/** Minimum setpoint movement worth re-sending: max(1 kW, 10 % of maxDischargeKw) — telemetry wiggle must not spam the bus. */
export function peakMinMoveKw(maxDischargeKw: number): number {
  return Math.max(1, 0.1 * maxDischargeKw);
}

/** Re-trim only on a meaningful change (or when nothing has been sent yet). */
export function peakRetrimDue(power: number, lastSent: number | null, minMoveKw: number): boolean {
  return lastSent == null || Math.abs(power - lastSent) >= minMoveKw;
}

// ─── EMS plans (v9 Contract A) ───────────────────────────────────────────────
/** Step function: kw of the last setpoint with ts ≤ now; null when none is due yet. */
export function planKwAt(setpoints: Array<{ ts: string; kw: number }>, nowMs: number): number | null {
  let kw: number | null = null;
  for (const sp of setpoints) {
    if (Date.parse(sp.ts) <= nowMs) kw = sp.kw;
    else break;
  }
  return kw;
}

/** kw > 0 = discharge, kw < 0 = charge, 0 = idle. */
export function kwToMode(kw: number): EmsMode {
  return kw > 0 ? "discharge" : kw < 0 ? "charge" : "idle";
}
