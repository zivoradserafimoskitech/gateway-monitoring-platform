import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rejectKey: "", failKey: "", writes: [] as string[] }));
vi.mock("./execute", () => {
  class ControlError extends Error {}
  return {
    ControlError,
    executeControl: async (_m: unknown, key: string) => {
      if (key === state.rejectKey) throw new ControlError(`'${key}' is not controllable`);
      return { status: "preview", detail: `would write ${key}` };
    },
    executeAndLog: async (_m: unknown, key: string) => {
      state.writes.push(key);
      if (key === state.failKey) return { status: "failed", detail: "read-back mismatch", commandId: 2 };
      return { status: "ok", detail: "verified", commandId: 1 };
    },
  };
});
import { executeSequence, validateSteps } from "./sequence";
import type { Meter } from "@db/schema";

const meter = { id: 1 } as Meter;
const noSleep = async () => undefined;

beforeEach(() => {
  state.rejectKey = "";
  state.failKey = "";
  state.writes = [];
});

describe("command sequences", () => {
  it("validates shape", () => {
    expect(validateSteps([])).toMatch(/at least one/);
    expect(validateSteps(Array.from({ length: 21 }, () => ({ key: "a", value: 1 })))).toMatch(/at most/);
    expect(validateSteps([{ key: "a", value: 1, delayMs: 70_000 }])).toMatch(/delayMs/);
    expect(validateSteps([{ key: "a", value: 1 }])).toBeNull();
  });
  it("writes nothing when any step would be refused", async () => {
    state.rejectKey = "b";
    const r = await executeSequence(meter, [{ key: "a", value: 1 }, { key: "b", value: 2 }, { key: "c", value: 3 }], 1, { sleepFn: noSleep });
    expect(r.status).toBe("rejected");
    expect(state.writes).toEqual([]);
    expect(r.steps.map((s) => s.status)).toEqual(["preview", "rejected", "skipped"]);
  });
  it("executes in order and completes", async () => {
    const slept: number[] = [];
    const r = await executeSequence(meter, [{ key: "a", value: 1 }, { key: "b", value: 2, delayMs: 500 }], 1, {
      sleepFn: async (ms) => void slept.push(ms),
    });
    expect(r.status).toBe("completed");
    expect(state.writes).toEqual(["a", "b"]);
    expect(slept).toEqual([500]);
  });
  it("aborts at the first failed step", async () => {
    state.failKey = "b";
    const r = await executeSequence(meter, [{ key: "a", value: 1 }, { key: "b", value: 2 }, { key: "c", value: 3 }], 1, { sleepFn: noSleep });
    expect(r.status).toBe("aborted");
    expect(state.writes).toEqual(["a", "b"]);
    expect(r.steps[2].status).toBe("skipped");
  });
  it("dry run only previews", async () => {
    const r = await executeSequence(meter, [{ key: "a", value: 1 }], 1, { dryRun: true });
    expect(r.status).toBe("preview");
    expect(state.writes).toEqual([]);
  });
});
