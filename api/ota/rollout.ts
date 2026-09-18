// §9.9: staged firmware rollouts, as pure decisions.
//
// Firmware could only be pushed one gateway at a time. In practice a fleet
// update is done by a script looping over every gateway, which is how an
// installation loses all of them at the same moment to a bad image — and
// firmware, unlike a setpoint, cannot be reliably rolled back over the air.
// Once a gateway is bricked or boots into an image that no longer speaks to
// the broker, nothing here can reach it.
//
// So the design is built around one idea: find out on ONE device, then a few,
// then the rest, and STOP the moment the numbers look wrong. There is no
// automatic rollback because there cannot be one; halting and telling somebody
// is the honest behaviour.

export type TargetStatus = "pending" | "sent" | "ack" | "failed";

export interface RolloutTarget {
  gatewayId: number;
  batchIndex: number;
  status: TargetStatus;
}

/**
 * Assign gateways to batches: a canary batch first, then fixed-size waves.
 *
 * The canary is deliberately its own batch even when it is one device. A
 * rollout that starts with ten is a rollout that can break ten.
 */
export function planBatches(gatewayIds: number[], canaryCount: number, batchSize: number): RolloutTarget[] {
  const canary = Math.max(1, Math.min(Math.floor(canaryCount) || 1, gatewayIds.length));
  const size = Math.max(1, Math.floor(batchSize) || 1);
  return gatewayIds.map((gatewayId, i) => ({
    gatewayId,
    batchIndex: i < canary ? 0 : 1 + Math.floor((i - canary) / size),
    status: "pending" as const,
  }));
}

export interface BatchCounts {
  total: number;
  pending: number;
  inFlight: number;
  ack: number;
  failed: number;
}

export function countBatch(targets: RolloutTarget[], batchIndex: number): BatchCounts {
  const inBatch = targets.filter((t) => t.batchIndex === batchIndex);
  return {
    total: inBatch.length,
    pending: inBatch.filter((t) => t.status === "pending").length,
    inFlight: inBatch.filter((t) => t.status === "sent").length,
    ack: inBatch.filter((t) => t.status === "ack").length,
    failed: inBatch.filter((t) => t.status === "failed").length,
  };
}

export type RolloutAction =
  | { kind: "dispatch"; batchIndex: number; gatewayIds: number[] }
  | { kind: "wait"; batchIndex: number }
  | { kind: "halt"; reason: string }
  | { kind: "done" };

export interface RolloutPolicy {
  /** Percentage of a settled batch that may fail before the rollout halts. */
  failureThresholdPct: number;
}

/**
 * What the rollout should do next.
 *
 * Rules, in order:
 *  1. A batch with anything still pending or in flight is WAITED on. Batches
 *     never overlap: the whole point is that each wave's result is known
 *     before the next one is exposed.
 *  2. ANY failure in the canary halts, whatever the threshold says. The canary
 *     exists to answer "does this image work at all", and one device out of
 *     one failing is a 100% failure rate however it is phrased.
 *  3. A later batch halts when its failure rate exceeds the threshold.
 *  4. Otherwise dispatch the next batch, or report done.
 */
export function nextAction(targets: RolloutTarget[], policy: RolloutPolicy): RolloutAction {
  if (targets.length === 0) return { kind: "done" };
  const batches = [...new Set(targets.map((t) => t.batchIndex))].sort((a, b) => a - b);

  // Batches are walked in order and the walk STOPS at the first one that is
  // not settled-and-healthy. An earlier unhealthy batch therefore halts before
  // a later one is ever considered — the ordering is what keeps "never expose
  // the next wave until this one's result is known" a property of the code
  // rather than a comment.
  for (const b of batches) {
    const c = countBatch(targets, b);

    if (c.pending > 0 || c.inFlight > 0) {
      // Nothing of this batch has been sent yet: it is the next wave.
      if (c.pending === c.total && c.inFlight === 0) {
        return {
          kind: "dispatch",
          batchIndex: b,
          gatewayIds: targets.filter((t) => t.batchIndex === b).map((t) => t.gatewayId),
        };
      }
      // Partly out: wait for it. Waves never overlap.
      return { kind: "wait", batchIndex: b };
    }

    // Settled. Judged here rather than when the next batch is considered, so a
    // rollout whose LAST batch failed does not report itself complete.
    if (b === 0 && c.failed > 0) {
      // ANY canary failure halts, whatever the threshold says: the canary
      // answers "does this image work at all", and one failure out of one is a
      // 100% failure rate however it is phrased.
      return { kind: "halt", reason: `canary failed on ${c.failed} of ${c.total} gateways` };
    }
    const pct = c.total === 0 ? 0 : (c.failed / c.total) * 100;
    if (pct > policy.failureThresholdPct) {
      return {
        kind: "halt",
        reason: `batch ${b} failed on ${c.failed} of ${c.total} gateways (${pct.toFixed(0)}% > ${policy.failureThresholdPct}%)`,
      };
    }
  }
  return { kind: "done" };
}

/** Progress for the screen: how far along, and how healthy. */
export function rolloutProgress(targets: RolloutTarget[]): {
  total: number;
  ack: number;
  failed: number;
  pending: number;
  inFlight: number;
  percent: number;
} {
  const total = targets.length;
  const ack = targets.filter((t) => t.status === "ack").length;
  const failed = targets.filter((t) => t.status === "failed").length;
  const pending = targets.filter((t) => t.status === "pending").length;
  const inFlight = targets.filter((t) => t.status === "sent").length;
  // Settled, not acked: a rollout that halted at 40% should not show a bar
  // that keeps implying the remaining 60% is still coming.
  const percent = total === 0 ? 0 : Math.round(((ack + failed) / total) * 100);
  return { total, ack, failed, pending, inFlight, percent };
}
