import { describe, expect, it, vi } from "vitest";
vi.mock("../queries/connection", () => ({ getDb: () => ({}) }));
vi.mock("../telemetry", () => ({ getTelemetryStore: () => ({}) }));
import { lastClosedInterval } from "./energy-intervals";

describe("lastClosedInterval", () => {
  it("returns the last settled 15-min window", () => {
    const r = lastClosedInterval(Date.parse("2026-10-24T12:16:00Z"));
    expect(r.from.toISOString()).toBe("2026-10-24T11:45:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-24T12:00:00.000Z");
    const r2 = lastClosedInterval(Date.parse("2026-10-24T12:17:30Z"));
    expect(r2.to.toISOString()).toBe("2026-10-24T12:15:00.000Z");
  });
});
