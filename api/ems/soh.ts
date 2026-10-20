// §9.5: battery state of health and cycle counting.
//
// A BESS is the most expensive thing on most of these sites and the only one
// that wears out by being used. Nothing here measured that: the platform knew
// a battery's SoC at any instant and nothing at all about how much life had
// been taken out of it. Warranties are written in equivalent full cycles and
// in retained capacity, so an installation could not answer the two questions
// its own contract is actually about.
//
// Everything in this file is pure and works from ordinary telemetry — SoC
// percentage and battery power — because that is all these devices report. No
// special instrumentation, no manufacturer API.

/** One telemetry sample: the two fields every BESS profile carries. */
export interface SocSample {
  ts: Date;
  socPercent: number | null;
  /** Signed kW, normalised by the profile: positive = discharging. */
  batteryPowerKw: number | null;
}

// ─── Cycle counting ──────────────────────────────────────────────────────────
/**
 * Equivalent full cycles from SoC movement.
 *
 * EFC is the industry's unit and the one warranties are written in: total SoC
 * travelled, divided by 200 because one full cycle is 100% down AND 100% back.
 * Counting "times it reached 100%" instead would score a battery that cycles
 * between 40% and 60% all day as having done nothing, which is the opposite of
 * the truth — that is a battery being worked hard in a narrow band.
 *
 * Deliberately NOT rainflow counting. Rainflow is the right model for
 * calendar-plus-cycle degradation studies, needs the whole history in memory to
 * close half-cycles, and answers a question nobody here is asking. EFC is what
 * the warranty says.
 */
export function efcDelta(prevSoc: number, soc: number): number {
  if (!Number.isFinite(prevSoc) || !Number.isFinite(soc)) return 0;
  return Math.abs(soc - prevSoc) / 200;
}

/**
 * Energy through the battery between two samples, in kWh, split by direction.
 *
 * Trapezoidal over the interval: a sample every few seconds with a step
 * assumption systematically over- or under-counts every ramp, and a battery
 * following a peak-shaving setpoint is ramping most of the time.
 *
 * Intervals longer than `maxGapMs` contribute NOTHING rather than being
 * integrated across. A gateway that was offline for six hours must not book
 * six hours of the last power reading it happened to send — that is how a
 * battery acquires thousands of phantom kWh of throughput after an outage.
 */
export function throughputDelta(
  prev: SocSample,
  next: SocSample,
  maxGapMs = 15 * 60_000,
): { dischargedKwh: number; chargedKwh: number } {
  const zero = { dischargedKwh: 0, chargedKwh: 0 };
  if (prev.batteryPowerKw === null || next.batteryPowerKw === null) return zero;
  const dtMs = next.ts.getTime() - prev.ts.getTime();
  if (dtMs <= 0 || dtMs > maxGapMs) return zero;
  const hours = dtMs / 3_600_000;
  const avgKw = (prev.batteryPowerKw + next.batteryPowerKw) / 2;
  // A sign change inside one interval makes the average meaningless in either
  // bucket — it would book nothing at all for a battery that both charged and
  // discharged — so the interval is split at the zero crossing instead.
  if (prev.batteryPowerKw * next.batteryPowerKw < 0) {
    const span = Math.abs(prev.batteryPowerKw) + Math.abs(next.batteryPowerKw);
    const firstFraction = Math.abs(prev.batteryPowerKw) / span;
    const firstKwh = (Math.abs(prev.batteryPowerKw) / 2) * hours * firstFraction;
    const secondKwh = (Math.abs(next.batteryPowerKw) / 2) * hours * (1 - firstFraction);
    return prev.batteryPowerKw > 0
      ? { dischargedKwh: firstKwh, chargedKwh: secondKwh }
      : { dischargedKwh: secondKwh, chargedKwh: firstKwh };
  }
  const kwh = Math.abs(avgKw) * hours;
  return avgKw >= 0 ? { dischargedKwh: kwh, chargedKwh: 0 } : { dischargedKwh: 0, chargedKwh: kwh };
}

// ─── Capacity / state of health ──────────────────────────────────────────────
export interface CapacityWindow {
  socStart: number;
  socEnd: number;
  dischargedKwh: number;
}

/**
 * Minimum SoC span an estimate is accepted from.
 *
 * A 5% discharge would divide by 0.05, so a 2% error in the reported SoC — well
 * within what a BMS reports — becomes a 40% error in the answer. Requiring a
 * deep window means fewer estimates and each one worth having.
 */
export const MIN_SOC_SPAN_PCT = 30;

/**
 * Usable capacity implied by one discharge window, in kWh, or null when the
 * window is not worth an estimate.
 *
 * The arithmetic is only: energy out ÷ fraction of the battery it emptied.
 */
export function capacityFromWindow(w: CapacityWindow, minSpanPct = MIN_SOC_SPAN_PCT): number | null {
  const span = w.socStart - w.socEnd;
  if (!Number.isFinite(span) || span < minSpanPct) return null;
  if (!(w.dischargedKwh > 0)) return null;
  return w.dischargedKwh / (span / 100);
}

/**
 * State of health as a percentage of nameplate.
 *
 * Clamped to 150 rather than 100: a reading above 100 is normal early in a
 * battery's life (manufacturers ship margin) and, more usefully, a reading of
 * 130 is a SIGN — nameplate misconfigured, or the sign convention inverted —
 * that silently clamping to 100 would hide.
 */
export function sohPercent(measuredKwh: number, nameplateKwh: number): number | null {
  if (!(nameplateKwh > 0) || !(measuredKwh > 0)) return null;
  return Math.min(150, (measuredKwh / nameplateKwh) * 100);
}

/**
 * Blend a new estimate into the running figure.
 *
 * An exponential average with a deliberately slow alpha. Capacity does not
 * jump; a single window that read low because the site drew from the battery
 * and the grid at once should nudge the number, not redefine it. The first
 * estimate is taken as-is — there is nothing to blend with, and starting from
 * an assumed 100% would make a tired battery look healthy for weeks.
 */
export function blendSoh(previous: number | null, estimate: number, alpha = 0.2): number {
  if (previous === null || !Number.isFinite(previous)) return estimate;
  const a = Math.min(1, Math.max(0, alpha));
  return previous * (1 - a) + estimate * a;
}

// ─── Window tracking ─────────────────────────────────────────────────────────
export interface WindowState {
  socStart: number;
  dischargedKwh: number;
}

export type WindowStep =
  | { kind: "idle"; next: WindowState | null }
  | { kind: "open"; next: WindowState }
  | { kind: "accumulate"; next: WindowState }
  | { kind: "close"; next: null; window: CapacityWindow };

/**
 * Follow a discharge, sample by sample, and close the window when it ends.
 *
 * A window runs from the moment the battery starts discharging until it stops
 * or starts charging. It is never extended across a charge: mixing a charge
 * into a discharge integral is how a 40% window turns into a capacity estimate
 * for a battery that was topped up halfway through.
 */
export function windowStep(
  state: WindowState | null,
  prev: SocSample | null,
  sample: SocSample,
  maxGapMs = 15 * 60_000,
): WindowStep {
  const soc = sample.socPercent;
  const power = sample.batteryPowerKw;
  if (soc === null || power === null) {
    // Unknown state: abandon any open window rather than carry it across a
    // blind stretch. Closed with ZERO energy and no span on purpose — with an
    // unknown endpoint there is nothing to divide by, and passing the
    // accumulated kWh on with a made-up endpoint is how a missing reading
    // becomes a confident wrong number about a battery's health.
    return state
      ? { kind: "close", next: null, window: { socStart: state.socStart, socEnd: state.socStart, dischargedKwh: 0 } }
      : { kind: "idle", next: null };
  }
  const discharging = power > 0;

  if (!state) {
    return discharging ? { kind: "open", next: { socStart: soc, dischargedKwh: 0 } } : { kind: "idle", next: null };
  }
  if (!discharging) {
    return {
      kind: "close",
      next: null,
      window: { socStart: state.socStart, socEnd: soc, dischargedKwh: state.dischargedKwh },
    };
  }
  const gap = prev ? sample.ts.getTime() - prev.ts.getTime() : 0;
  if (prev && gap > maxGapMs) {
    // A hole in the data mid-discharge: the integral is no longer a complete
    // account of the energy, so the window is abandoned rather than reported.
    return { kind: "close", next: null, window: { socStart: state.socStart, socEnd: soc, dischargedKwh: 0 } };
  }
  const add = prev ? throughputDelta(prev, sample, maxGapMs).dischargedKwh : 0;
  return { kind: "accumulate", next: { socStart: state.socStart, dischargedKwh: state.dischargedKwh + add } };
}
