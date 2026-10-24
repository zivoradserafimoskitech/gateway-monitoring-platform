// Alarm conditions beyond a single threshold (pure, no I/O).
//
//   gt / lt     value vs threshold, with optional DEADBAND: once breached, a
//               "gt" rule only clears when value <= threshold - deadband (and
//               "lt" when value >= threshold + deadband). Stops a signal that
//               hovers at the threshold from raising/clearing every sample.
//   roc         rate of change: |Δvalue| per minute > threshold, computed from
//               the previous sample of the same (rule, device). Catches a
//               battery temperature climbing fast while still under its limit.
//   composite   AND / OR of up to 8 gt/lt terms over different metrics of the
//               same device, e.g. "SoC < 10 AND grid import > 50 kW".
// "stuck" stays in api/alarms/stuck.ts (it needs the telemetry store).

export type SimpleOperator = "gt" | "lt";

export interface Term {
  metric: string;
  operator: SimpleOperator;
  threshold: number;
}

export interface CompositeSpec {
  op: "and" | "or";
  terms: Term[];
}

export const MAX_TERMS = 8;
const METRIC_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

export function validateComposite(spec: unknown): CompositeSpec | string {
  if (!spec || typeof spec !== "object") return "conditions must be an object";
  const s = spec as Record<string, unknown>;
  if (s.op !== "and" && s.op !== "or") return "conditions.op must be 'and' or 'or'";
  if (!Array.isArray(s.terms) || s.terms.length < 2 || s.terms.length > MAX_TERMS) return `conditions.terms must have 2..${MAX_TERMS} entries`;
  const terms: Term[] = [];
  for (const [i, t] of (s.terms as unknown[]).entries()) {
    const r = t as Record<string, unknown>;
    if (typeof r?.metric !== "string" || !METRIC_RE.test(r.metric)) return `term ${i + 1}: invalid metric`;
    if (r.operator !== "gt" && r.operator !== "lt") return `term ${i + 1}: operator must be gt or lt`;
    if (typeof r.threshold !== "number" || !Number.isFinite(r.threshold)) return `term ${i + 1}: threshold must be a number`;
    terms.push({ metric: r.metric, operator: r.operator, threshold: r.threshold });
  }
  return { op: s.op, terms };
}

/** Threshold compare with deadband hysteresis. */
export function thresholdBreached(
  operator: SimpleOperator,
  value: number,
  threshold: number,
  wasBreached: boolean,
  deadband: number | null | undefined,
): boolean {
  const db = Math.max(0, deadband ?? 0);
  if (operator === "gt") return wasBreached ? value > threshold - db : value > threshold;
  return wasBreached ? value < threshold + db : value < threshold;
}

export interface RocSample {
  value: number;
  at: number;
}

/**
 * Rate of change in units per minute between two samples; null when there is
 * no usable previous sample (first sample, clock went backwards, or samples
 * less than 1 s apart — too noisy to differentiate).
 */
export function ratePerMinute(prev: RocSample | undefined, value: number, at: number): number | null {
  if (!prev) return null;
  const dt = at - prev.at;
  if (dt < 1000) return null;
  return ((value - prev.value) / dt) * 60_000;
}

export function rocBreached(rate: number | null, threshold: number, wasBreached: boolean, deadband: number | null | undefined): boolean {
  if (rate === null) return wasBreached; // no new information: keep state
  return thresholdBreached("gt", Math.abs(rate), threshold, wasBreached, deadband);
}

/**
 * Composite evaluation. Returns null when a term's metric is missing from
 * this sample AND the result cannot be decided without it — a device that
 * did not report a metric must not raise (or clear) on a guess.
 */
export function compositeBreached(
  spec: CompositeSpec,
  values: Record<string, number>,
  wasBreached: boolean,
  deadband: number | null | undefined,
): boolean | null {
  let unknown = false;
  const results: boolean[] = [];
  for (const t of spec.terms) {
    const v = values[t.metric];
    if (v === undefined || v === null || !Number.isFinite(v)) {
      unknown = true;
      continue;
    }
    results.push(thresholdBreached(t.operator, v, t.threshold, wasBreached, deadband));
  }
  if (spec.op === "and") {
    if (results.some((r) => !r)) return false;
    return unknown ? null : true;
  }
  if (results.some((r) => r)) return true;
  return unknown ? null : false;
}

/** Human-readable composite, for alarm messages. */
export function describeComposite(spec: CompositeSpec): string {
  return spec.terms.map((t) => `${t.metric} ${t.operator === "gt" ? ">" : "<"} ${t.threshold}`).join(` ${spec.op.toUpperCase()} `);
}
