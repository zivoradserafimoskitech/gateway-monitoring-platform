// Alarm hysteresis and duration. The properties that matter: a condition must
// hold for the configured time before anyone is woken, a brief spike leaves no
// trace, and an alarm clears exactly once.
import { test, expect, describe } from "vitest";
import { alarmTransition, type BreachRecord } from "../api/alarms/hysteresis";

const clear: BreachRecord = { breached: false, since: null, raisedAt: null };
const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const min = 60_000;

describe("without a duration (raise immediately)", () => {
  test("the first breaching sample raises", () => {
    const r = alarmTransition(clear, true, t0, 0);
    expect(r.action).toBe("raise");
    expect(r.next).toEqual({ breached: true, since: t0, raisedAt: t0 });
  });

  test("further breaching samples do nothing", () => {
    const raised: BreachRecord = { breached: true, since: t0, raisedAt: t0 };
    expect(alarmTransition(raised, true, t0 + 5 * min, 0).action).toBe("none");
  });

  test("the condition ending clears once", () => {
    const raised: BreachRecord = { breached: true, since: t0, raisedAt: t0 };
    const r = alarmTransition(raised, false, t0 + min, 0);
    expect(r.action).toBe("clear");
    expect(r.next).toEqual(clear);
    // And again on the next sample: already cleared, so nothing more.
    expect(alarmTransition(r.next, false, t0 + 2 * min, 0).action).toBe("none");
  });
});

describe("with a duration", () => {
  test("a breach starts the clock without raising", () => {
    const r = alarmTransition(clear, true, t0, 5 * min);
    expect(r.action).toBe("none");
    expect(r.next).toEqual({ breached: true, since: t0, raisedAt: null });
  });

  test("it raises once the condition has held long enough", () => {
    const started: BreachRecord = { breached: true, since: t0, raisedAt: null };
    expect(alarmTransition(started, true, t0 + 4 * min, 5 * min).action).toBe("none");
    const r = alarmTransition(started, true, t0 + 5 * min, 5 * min);
    expect(r.action).toBe("raise");
    expect(r.next.raisedAt).toBe(t0 + 5 * min);
    // `since` stays the START of the condition, not the moment it was raised.
    expect(r.next.since).toBe(t0);
  });

  test("a spike shorter than the duration wakes nobody and leaves no state", () => {
    // This is the whole point: one noisy sample over the threshold should not
    // page anyone, and should not look like an ongoing condition afterwards.
    const started = alarmTransition(clear, true, t0, 5 * min).next;
    const ended = alarmTransition(started, false, t0 + 2 * min, 5 * min);
    expect(ended.action).toBe("none");
    expect(ended.next).toEqual(clear);
  });

  test("the clock restarts after a gap, so flapping never accumulates", () => {
    const first = alarmTransition(clear, true, t0, 5 * min).next;
    const gap = alarmTransition(first, false, t0 + min, 5 * min).next;
    const second = alarmTransition(gap, true, t0 + 2 * min, 5 * min);
    expect(second.action).toBe("none");
    expect(second.next.since).toBe(t0 + 2 * min);
  });

  test("an already-raised alarm stays raised across the duration boundary", () => {
    const raised: BreachRecord = { breached: true, since: t0, raisedAt: t0 + 5 * min };
    const r = alarmTransition(raised, true, t0 + 60 * min, 5 * min);
    expect(r.action).toBe("none");
    expect(r.next.raisedAt).toBe(t0 + 5 * min);
  });

  test("clearing after a raise still clears", () => {
    const raised: BreachRecord = { breached: true, since: t0, raisedAt: t0 + 5 * min };
    expect(alarmTransition(raised, false, t0 + 9 * min, 5 * min).action).toBe("clear");
  });
});

test("state recovered from an open alarm row keeps raising suppressed", () => {
  // After a restart the state is rebuilt from the alarm row, which means
  // raisedAt is set. The rule must not fire a second time for the same
  // ongoing condition.
  const recovered: BreachRecord = { breached: true, since: t0, raisedAt: t0 };
  expect(alarmTransition(recovered, true, t0 + 120 * min, 0).action).toBe("none");
});
