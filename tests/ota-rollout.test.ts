// §9.9: staged rollouts. Firmware cannot be rolled back over the air, so the
// only protection is finding out on one device before exposing the fleet —
// which makes "when does this halt" the property worth testing hardest.
import { describe, it, expect } from "vitest";
import {
  countBatch,
  nextAction,
  planBatches,
  rolloutProgress,
  type RolloutTarget,
} from "../api/ota/rollout";

const POLICY = { failureThresholdPct: 10 };
const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

function withStatus(targets: RolloutTarget[], gatewayId: number, status: RolloutTarget["status"]): RolloutTarget[] {
  return targets.map((t) => (t.gatewayId === gatewayId ? { ...t, status } : t));
}

function setBatch(targets: RolloutTarget[], batchIndex: number, status: RolloutTarget["status"]): RolloutTarget[] {
  return targets.map((t) => (t.batchIndex === batchIndex ? { ...t, status } : t));
}

describe("planBatches", () => {
  it("puts the canary in a batch of its own", () => {
    const plan = planBatches(ids(7), 1, 3);
    expect(plan.filter((t) => t.batchIndex === 0).map((t) => t.gatewayId)).toEqual([1]);
    expect(plan.filter((t) => t.batchIndex === 1).map((t) => t.gatewayId)).toEqual([2, 3, 4]);
    expect(plan.filter((t) => t.batchIndex === 2).map((t) => t.gatewayId)).toEqual([5, 6, 7]);
  });

  it("supports a canary of more than one", () => {
    const plan = planBatches(ids(6), 2, 2);
    expect(plan.filter((t) => t.batchIndex === 0).map((t) => t.gatewayId)).toEqual([1, 2]);
    expect(plan.filter((t) => t.batchIndex === 1).map((t) => t.gatewayId)).toEqual([3, 4]);
  });

  it("never plans a zero-size canary or batch", () => {
    // A rollout with no canary is the loop-over-every-gateway script this
    // feature exists to replace.
    const plan = planBatches(ids(4), 0, 0);
    expect(plan[0].batchIndex).toBe(0);
    expect(new Set(plan.map((t) => t.batchIndex)).size).toBe(4);
  });

  it("copes with a fleet smaller than the canary", () => {
    const plan = planBatches([9], 5, 10);
    expect(plan).toEqual([{ gatewayId: 9, batchIndex: 0, status: "pending" }]);
  });

  it("starts everything pending", () => {
    expect(planBatches(ids(3), 1, 2).every((t) => t.status === "pending")).toBe(true);
  });
});

describe("nextAction", () => {
  it("dispatches the canary first", () => {
    const plan = planBatches(ids(10), 1, 4);
    expect(nextAction(plan, POLICY)).toEqual({ kind: "dispatch", batchIndex: 0, gatewayIds: [1] });
  });

  it("waits while a wave is in flight and never overlaps waves", () => {
    let plan = planBatches(ids(10), 1, 4);
    plan = withStatus(plan, 1, "sent");
    expect(nextAction(plan, POLICY)).toEqual({ kind: "wait", batchIndex: 0 });
  });

  it("moves to the next wave once the canary acks", () => {
    let plan = planBatches(ids(10), 1, 4);
    plan = withStatus(plan, 1, "ack");
    expect(nextAction(plan, POLICY)).toEqual({ kind: "dispatch", batchIndex: 1, gatewayIds: [2, 3, 4, 5] });
  });

  it("halts on ANY canary failure, whatever the threshold says", () => {
    // One device out of one is a 100% failure rate however it is phrased, and
    // the canary's whole job is to answer "does this image work at all".
    let plan = planBatches(ids(100), 1, 10);
    plan = withStatus(plan, 1, "failed");
    const action = nextAction(plan, { failureThresholdPct: 90 });
    expect(action.kind).toBe("halt");
    expect(action.kind === "halt" && action.reason).toContain("canary");
  });

  it("halts a later wave once its failure rate exceeds the threshold", () => {
    let plan = planBatches(ids(11), 1, 10);
    plan = withStatus(plan, 1, "ack");
    plan = setBatch(plan, 1, "ack");
    // 2 of 10 = 20% > 10%.
    plan = withStatus(plan, 2, "failed");
    plan = withStatus(plan, 3, "failed");
    const action = nextAction(plan, POLICY);
    expect(action.kind).toBe("halt");
    expect(action.kind === "halt" && action.reason).toContain("20%");
  });

  it("continues when a wave's failures stay within the threshold", () => {
    let plan = planBatches(ids(21), 1, 10);
    plan = withStatus(plan, 1, "ack");
    plan = setBatch(plan, 1, "ack");
    plan = withStatus(plan, 2, "failed"); // 1 of 10 = 10%, not MORE than 10%
    expect(nextAction(plan, POLICY).kind).toBe("dispatch");
  });

  it("does not report a rollout complete when its LAST wave failed", () => {
    // The bug this prevents: judging a batch only when deciding the next one,
    // so the final batch's failures are never looked at.
    let plan = planBatches(ids(11), 1, 10);
    plan = withStatus(plan, 1, "ack");
    plan = setBatch(plan, 1, "failed");
    expect(nextAction(plan, POLICY).kind).toBe("halt");
  });

  it("reports done when every wave acked", () => {
    let plan = planBatches(ids(5), 1, 2);
    plan = plan.map((t) => ({ ...t, status: "ack" as const }));
    expect(nextAction(plan, POLICY)).toEqual({ kind: "done" });
  });

  it("is done immediately for an empty rollout rather than dispatching nothing forever", () => {
    expect(nextAction([], POLICY)).toEqual({ kind: "done" });
  });

  it("a zero threshold means no failure at all is tolerated", () => {
    let plan = planBatches(ids(21), 1, 10);
    plan = withStatus(plan, 1, "ack");
    plan = setBatch(plan, 1, "ack");
    plan = withStatus(plan, 2, "failed");
    expect(nextAction(plan, { failureThresholdPct: 0 }).kind).toBe("halt");
  });
});

describe("countBatch and rolloutProgress", () => {
  it("counts a wave by state", () => {
    let plan = planBatches(ids(5), 1, 4);
    plan = withStatus(plan, 2, "sent");
    plan = withStatus(plan, 3, "ack");
    plan = withStatus(plan, 4, "failed");
    expect(countBatch(plan, 1)).toEqual({ total: 4, pending: 1, inFlight: 1, ack: 1, failed: 1 });
  });

  it("counts settled, not acked — a halted rollout must not imply more is coming", () => {
    let plan = planBatches(ids(10), 1, 9);
    plan = withStatus(plan, 1, "ack");
    plan = withStatus(plan, 2, "failed");
    const p = rolloutProgress(plan);
    expect(p.ack).toBe(1);
    expect(p.failed).toBe(1);
    expect(p.percent).toBe(20);
  });

  it("is zero percent, not NaN, for an empty rollout", () => {
    expect(rolloutProgress([]).percent).toBe(0);
  });
});
