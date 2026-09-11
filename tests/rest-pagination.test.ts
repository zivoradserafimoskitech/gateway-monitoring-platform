// Opt-in keyset pagination for the public REST list endpoints. The contract
// that matters: WITHOUT a limit parameter the endpoints behave exactly as they
// did before, so an existing integration cannot start silently losing rows.
import { test, expect } from "vitest";
import { pageLimit, parseAlarmCursor } from "../api/rest/v1";

test("no limit parameter means the legacy unpaginated response", () => {
  expect(pageLimit(undefined)).toBeNull();
});

test("a limit is honoured and capped at the page maximum", () => {
  expect(pageLimit("1")).toBe(1);
  expect(pageLimit("50")).toBe(50);
  expect(pageLimit("500")).toBe(500);
  expect(pageLimit("100000")).toBe(500);
});

test("a nonsense limit falls back to the legacy response rather than erroring", () => {
  for (const bad of ["0", "-5", "abc", "1.5", ""]) {
    expect(pageLimit(bad), bad).toBeNull();
  }
});

test("an alarm cursor round-trips a timestamp and an id", () => {
  const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
  const parsed = parseAlarmCursor(`${ms}_4321`);
  expect(parsed).not.toBeNull();
  expect(parsed!.ts.getTime()).toBe(ms);
  expect(parsed!.id).toBe(4321);
});

test("alarms sharing a timestamp are separated by the id half of the cursor", () => {
  // Several alarms raised by one offline sweep carry the same triggeredAt.
  // Paging on the timestamp alone would drop or repeat them, so the id must
  // survive the round trip.
  const ms = Date.UTC(2026, 5, 1);
  expect(parseAlarmCursor(`${ms}_9`)!.id).toBe(9);
  expect(parseAlarmCursor(`${ms}_10`)!.id).toBe(10);
});

test("a malformed cursor is rejected so the endpoint can answer 400", () => {
  for (const bad of [undefined, "", "abc", "123", "abc_1", "123_abc", "_"]) {
    expect(parseAlarmCursor(bad), String(bad)).toBeNull();
  }
});
