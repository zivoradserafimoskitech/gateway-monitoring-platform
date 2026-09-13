// §9.7: the frozen-register detector. Pure decisions, so the cases that matter
// can be driven exactly rather than waited for.
import { describe, it, expect } from "vitest";
import { confirmStuck, stuckStep, type StuckRecord } from "../api/alarms/stuck";

const WINDOW = 30 * 60_000; // 30 minutes

describe("stuckStep", () => {
  it("starts a run on the first sample", () => {
    const s = stuckStep(undefined, 230.1, 1000, WINDOW);
    expect(s.kind).toBe("changed");
    expect(s.next).toEqual({ value: 230.1, since: 1000 });
  });

  it("restarts the run whenever the value moves", () => {
    const prev: StuckRecord = { value: 230.1, since: 1000 };
    const s = stuckStep(prev, 230.2, 5000, WINDOW);
    expect(s.kind).toBe("changed");
    expect(s.next).toEqual({ value: 230.2, since: 5000 });
  });

  it("costs nothing while the run is younger than the window", () => {
    // The hot path: every sample of every healthy device lands here, so this
    // must never ask for a query.
    const prev: StuckRecord = { value: 230.1, since: 1000 };
    const s = stuckStep(prev, 230.1, 1000 + WINDOW - 1, WINDOW);
    expect(s.kind).toBe("unchanged");
    expect(s.next.since).toBe(1000);
  });

  it("asks for confirmation once the run reaches the window", () => {
    const prev: StuckRecord = { value: 230.1, since: 1000 };
    const s = stuckStep(prev, 230.1, 1000 + WINDOW, WINDOW);
    expect(s.kind).toBe("suspect");
  });

  it("treats a repeated NaN as unchanged", () => {
    // A profile whose scaling produces NaN would otherwise look like a value
    // that changes on every sample and could never be detected as frozen.
    const prev: StuckRecord = { value: NaN, since: 1000 };
    expect(stuckStep(prev, NaN, 2000, WINDOW).kind).toBe("unchanged");
  });

  it("treats -0 after 0 as a change", () => {
    const prev: StuckRecord = { value: 0, since: 1000 };
    expect(stuckStep(prev, -0, 2000, WINDOW).kind).toBe("changed");
  });

  it("never reports stuck when the window is zero", () => {
    // Otherwise the first repeated sample of every device on the fleet fires.
    const prev: StuckRecord = { value: 5, since: 1000 };
    expect(stuckStep(prev, 5, 9_999_999, 0).kind).toBe("unchanged");
  });
});

describe("confirmStuck", () => {
  const rec: StuckRecord = { value: 230.1, since: 1000 };

  it("confirms when nothing in the window disagrees", () => {
    expect(confirmStuck(rec, null, 1000 + WINDOW, WINDOW)).toEqual({ stuck: true, next: rec });
  });

  it("clears when a differing sample exists, and restarts from it", () => {
    // The in-memory run is per replica and dies with the process; the stored
    // sample is what actually happened, so the next window is measured from it.
    const changedAt = 1000 + WINDOW - 60_000;
    const out = confirmStuck(rec, changedAt, 1000 + WINDOW, WINDOW);
    expect(out.stuck).toBe(false);
    expect(out.next.since).toBe(changedAt);
  });

  it("still reports stuck when the differing sample is older than the window", () => {
    // A replica that started five minutes ago has a young run, but the
    // database shows the register has not moved for a day. Without this, a
    // restart would silently reset the clock and the alarm would never fire.
    const changedAt = 0;
    const out = confirmStuck({ value: 230.1, since: 1000 }, changedAt, 2 * WINDOW, WINDOW);
    expect(out.stuck).toBe(true);
    expect(out.next.since).toBe(changedAt);
  });
});
