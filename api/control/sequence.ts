// Command sequences: an ordered list of setpoint writes to ONE device, e.g.
// "enable remote mode → set power limit → set active power (FC16)".
//
// Safety: every step is first validated through the real chokepoint in
// dry-run mode (whitelist, verification gate, emergency stop, range, FC/type
// encoding). If any step would be refused, NOTHING is written. Execution is
// then strictly sequential through executeAndLog (each step audited), with an
// optional delay, and stops at the first step that does not succeed — a
// half-applied sequence is reported, never silently continued.
import type { Meter } from "@db/schema";
import { ControlError, executeAndLog, executeControl } from "./execute";

export interface SequenceStep {
  key: string;
  value: number;
  /** Wait before this step, ms (0..60000). */
  delayMs?: number;
}

export const SEQUENCE_MAX_STEPS = 20;
export const SEQUENCE_MAX_DELAY_MS = 60_000;

export interface StepResult {
  index: number;
  key: string;
  value: number;
  status: "ok" | "sent" | "failed" | "preview" | "skipped" | "rejected";
  detail: string;
  commandId?: number;
}

export interface SequenceResult {
  status: "completed" | "aborted" | "rejected" | "preview";
  steps: StepResult[];
}

export function validateSteps(steps: SequenceStep[]): string | null {
  if (!Array.isArray(steps) || steps.length === 0) return "a sequence needs at least one step";
  if (steps.length > SEQUENCE_MAX_STEPS) return `a sequence may have at most ${SEQUENCE_MAX_STEPS} steps`;
  for (const [i, s] of steps.entries()) {
    if (typeof s.key !== "string" || !s.key) return `step ${i + 1}: key is required`;
    if (typeof s.value !== "number" || !Number.isFinite(s.value)) return `step ${i + 1}: value must be finite`;
    if (s.delayMs !== undefined && (!Number.isInteger(s.delayMs) || s.delayMs < 0 || s.delayMs > SEQUENCE_MAX_DELAY_MS)) {
      return `step ${i + 1}: delayMs must be an integer in 0..${SEQUENCE_MAX_DELAY_MS}`;
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function executeSequence(
  meter: Meter,
  steps: SequenceStep[],
  userId: number | null,
  opts: { dryRun?: boolean; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<SequenceResult> {
  const invalid = validateSteps(steps);
  if (invalid) throw new ControlError(invalid);

  // Phase 1: validate every step through the real path, no bus traffic.
  const previews: StepResult[] = [];
  for (const [index, s] of steps.entries()) {
    try {
      const r = await executeControl(meter, s.key, s.value, { dryRun: true });
      previews.push({ index, key: s.key, value: s.value, status: "preview", detail: r.detail });
    } catch (e) {
      if (!(e instanceof ControlError)) throw e;
      previews.push({ index, key: s.key, value: s.value, status: "rejected", detail: e.message });
      const rest = steps.slice(index + 1).map((t, j) => ({ index: index + 1 + j, key: t.key, value: t.value, status: "skipped" as const, detail: "not attempted" }));
      return { status: "rejected", steps: [...previews, ...rest] };
    }
  }
  if (opts.dryRun) return { status: "preview", steps: previews };

  // Phase 2: execute in order, stop at the first non-success.
  const wait = opts.sleepFn ?? sleep;
  const out: StepResult[] = [];
  for (const [index, s] of steps.entries()) {
    if (s.delayMs) await wait(s.delayMs);
    try {
      const r = await executeAndLog(meter, s.key, s.value, userId);
      out.push({ index, key: s.key, value: s.value, status: r.status as StepResult["status"], detail: r.detail, commandId: (r as { commandId?: number }).commandId });
      if (r.status === "failed") {
        for (const [j, t] of steps.slice(index + 1).entries()) out.push({ index: index + 1 + j, key: t.key, value: t.value, status: "skipped", detail: "previous step failed" });
        return { status: "aborted", steps: out };
      }
    } catch (e) {
      if (!(e instanceof ControlError)) throw e;
      out.push({ index, key: s.key, value: s.value, status: "rejected", detail: e.message });
      for (const [j, t] of steps.slice(index + 1).entries()) out.push({ index: index + 1 + j, key: t.key, value: t.value, status: "skipped", detail: "previous step rejected" });
      return { status: "aborted", steps: out };
    }
  }
  return { status: "completed", steps: out };
}
