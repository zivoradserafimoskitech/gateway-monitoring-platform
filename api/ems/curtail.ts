// §9.2: site-level grid import/export limit with curtailment.
//
// A grid connection agreement caps how much a site may draw and, more often
// the binding one, how much it may push back. Exceeding it is a contractual
// and in many markets a regulatory event, not an inconvenience — which is why
// this has to hold without a human watching.
//
// Peak shaving (already in the controller) is the neighbouring feature and not
// this one: it discharges ONE battery above ONE threshold. A connection limit
// binds on both directions, has to share the work across several assets in a
// defined order, and its hardest case — too much PV going out — needs
// generation turned DOWN, which nothing in the system could do before.
//
// ── Why this is a closed loop, and what that forces ──────────────────────────
// Curtailing changes the very measurement that asked for it. Recomputing the
// target from each new reading would therefore oscillate: curtail hard, see
// the export collapse, release fully, see it breach again. So the controller
// holds a total curtailment and NUDGES it — up by the overshoot, down by the
// headroom, both bounded per tick. That is an integral controller with a
// deadband, and the deadband is what stops it hunting around the limit.
//
// Every function here is pure. The controller owns the telemetry, the lease,
// the writes and the durable state; this file owns only the arithmetic, so the
// behaviour that matters can be driven exactly instead of waited for.

export interface GridLimits {
  /** Maximum kW drawn FROM the grid; null = no import limit. */
  maxImportKw: number | null;
  /** Maximum kW pushed TO the grid, as a positive magnitude; null = none. */
  maxExportKw: number | null;
  /** Release only once this far inside the limit, so the loop stops hunting. */
  deadbandKw: number;
  /** Most the total curtailment may move in one tick, in kW. */
  maxStepKw: number;
}

export type GridState = "ok" | "over-import" | "over-export";

export interface GridStatus {
  state: GridState;
  /** kW past the limit (0 when inside it). */
  excessKw: number;
  /** kW of room to the limit, past the deadband (0 when there is none). */
  headroomKw: number;
}

/**
 * Where the site sits against its connection limits.
 *
 * `gridKw` is signed at the point of common coupling: positive is import,
 * negative is export — the same convention as the meter's activePowerKw, so
 * no sign juggling happens at the call site where it would be easy to invert
 * and curtail in the wrong direction.
 */
export function gridStatus(gridKw: number, limits: GridLimits): GridStatus {
  const { maxImportKw, maxExportKw, deadbandKw } = limits;
  if (maxExportKw !== null && -gridKw > maxExportKw) {
    return { state: "over-export", excessKw: -gridKw - maxExportKw, headroomKw: 0 };
  }
  if (maxImportKw !== null && gridKw > maxImportKw) {
    return { state: "over-import", excessKw: gridKw - maxImportKw, headroomKw: 0 };
  }
  // Inside the limits: how much room is there beyond the deadband? That is
  // what may be given back this tick, and no more.
  let headroom = Infinity;
  if (maxExportKw !== null) headroom = Math.min(headroom, maxExportKw - -gridKw - deadbandKw);
  if (maxImportKw !== null) headroom = Math.min(headroom, maxImportKw - gridKw - deadbandKw);
  return { state: "ok", excessKw: 0, headroomKw: Math.max(0, headroom === Infinity ? 0 : headroom) };
}

/**
 * Next total curtailment, in kW of generation held back.
 *
 * Rising is deliberately unbounded by headroom and falling is not: a breach is
 * happening now and must be answered now, while giving capacity back is
 * optional and can wait for the next tick. Both are still capped by
 * `maxStepKw`, so a spike in the measurement cannot slam every inverter shut
 * in one step.
 */
export function stepCurtailment(currentKw: number, status: GridStatus, limits: GridLimits): number {
  const step = Math.max(0, limits.maxStepKw);
  if (status.state === "over-export") {
    return currentKw + Math.min(status.excessKw, step);
  }
  if (status.state === "over-import") {
    // Import is the other direction: generation is not the lever — holding
    // LESS back is. Releasing here is bounded by the excess, not the headroom,
    // because the site is over its limit and every kW returned helps.
    return Math.max(0, currentKw - Math.min(status.excessKw, step));
  }
  if (currentKw <= 0) return 0;
  return Math.max(0, currentKw - Math.min(status.headroomKw, step));
}

export interface CurtailAsset {
  meterId: number;
  /** Lower number curtails first. */
  priority: number;
  /** Nameplate kW — the denominator when a limit register is a percentage. */
  ratedKw: number;
  /** What it is producing right now; null when telemetry is missing. */
  outputKw: number | null;
}

export interface AssetShare {
  meterId: number;
  /** kW this asset must hold back. */
  takeKw: number;
  ratedKw: number;
}

/**
 * Split a total curtailment across assets in priority order.
 *
 * Greedy rather than proportional, because the priority column exists to be
 * obeyed: an operator who ranks the leased array above the owned one means
 * the leased one is curtailed to nothing before the owned one gives up a
 * kilowatt. Proportional sharing would quietly ignore that.
 *
 * An asset can only give back what it is making, so its share is capped by its
 * own output. Unknown output (no telemetry) is treated as zero available: the
 * remainder passes to the next asset instead of being assigned to one that
 * might not be running.
 */
export function allocateCurtailment(totalKw: number, assets: CurtailAsset[]): AssetShare[] {
  let remaining = Math.max(0, totalKw);
  const ordered = [...assets].sort((a, b) => a.priority - b.priority || a.meterId - b.meterId);
  return ordered.map((a) => {
    const available = Math.max(0, a.outputKw ?? 0);
    const take = Math.min(remaining, available);
    remaining -= take;
    return { meterId: a.meterId, takeKw: Math.round(take * 1000) / 1000, ratedKw: a.ratedKw };
  });
}

/**
 * A share expressed as the percentage an inverter's power-limit register wants.
 *
 * activePowerLimitPct is the established key for this (it is what the profile
 * importer and the control probes already use). A rated power of zero would be
 * a division by zero and means the profile is not configured for curtailment —
 * 100 (no limit) is the safe answer there, because inventing a limit for a
 * device whose rating is unknown is how a site loses generation it did not
 * have to.
 */
export function limitPct(share: AssetShare): number {
  if (!(share.ratedKw > 0)) return 100;
  const allowedKw = Math.max(0, share.ratedKw - share.takeKw);
  const pct = (allowedKw / share.ratedKw) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}
