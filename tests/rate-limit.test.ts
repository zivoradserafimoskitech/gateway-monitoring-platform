// §9.13: the token bucket. Pure, so "what happens at exactly the limit" and
// "what happens when the clock goes backwards" are tests rather than hopes.
import { describe, it, expect } from "vitest";
import { limitFor, takeToken, type BucketState } from "../api/rest/rate-limit";

const LIMIT = { perMinute: 60, burst: 60 }; // one token per second
const T0 = new Date("2026-03-10T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("takeToken", () => {
  it("starts full for a key that has never called", () => {
    const d = takeToken(null, LIMIT, T0);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(59);
  });

  it("spends the burst and then refuses", () => {
    let state: BucketState | null = null;
    for (let i = 0; i < 60; i++) {
      const d = takeToken(state, LIMIT, T0);
      expect(d.allowed).toBe(true);
      state = d.next;
    }
    const over = takeToken(state, LIMIT, T0);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("says when to come back, rounded up so an obedient client is not refused twice", () => {
    const empty: BucketState = { tokens: 0, updatedAt: T0 };
    // 60/min = one token per second, so a full token is 1s away.
    expect(takeToken(empty, LIMIT, T0).retryAfterSec).toBe(1);
    // Half a token in hand: still advertised as one second, never zero.
    expect(takeToken({ tokens: 0.5, updatedAt: T0 }, LIMIT, T0).retryAfterSec).toBe(1);
    // A slow bucket: 6/min is one token per ten seconds.
    expect(takeToken(empty, { perMinute: 6, burst: 6 }, T0).retryAfterSec).toBe(10);
  });

  it("refills continuously rather than in a clump each minute", () => {
    const empty: BucketState = { tokens: 0, updatedAt: T0 };
    // Half a second is half a token: still not enough for a request.
    expect(takeToken(empty, LIMIT, at(500)).allowed).toBe(false);
    expect(takeToken(empty, LIMIT, at(1000)).allowed).toBe(true);
    // Ten seconds of quiet is ten tokens, less the one just spent.
    expect(takeToken(empty, LIMIT, at(10_000)).remaining).toBe(9);
  });

  it("never saves up more than the burst", () => {
    const empty: BucketState = { tokens: 0, updatedAt: T0 };
    // An hour idle would be 3600 tokens at this rate; the cap is 60.
    const d = takeToken(empty, LIMIT, at(3_600_000));
    expect(d.remaining).toBe(59);
    expect(d.next.tokens).toBe(59);
  });

  it("does not drain the bucket when the clock steps backwards", () => {
    // Clock skew between replicas, or an NTP step, must never charge a caller
    // for time that ran the wrong way.
    const state: BucketState = { tokens: 10, updatedAt: at(60_000) };
    const d = takeToken(state, LIMIT, T0);
    expect(d.allowed).toBe(true);
    expect(d.next.tokens).toBe(9);
  });

  it("a rejected request does not consume the refill it computed", () => {
    const empty: BucketState = { tokens: 0, updatedAt: T0 };
    const d = takeToken(empty, LIMIT, at(500));
    expect(d.allowed).toBe(false);
    expect(d.next.tokens).toBeCloseTo(0.5, 10);
  });
});

describe("limitFor", () => {
  it("prices the scopes differently", () => {
    // A range scan and a plan push do not cost what a device listing costs, so
    // they do not share its budget.
    expect(limitFor("read").perMinute).toBe(120);
    expect(limitFor("telemetry:read").perMinute).toBe(60);
    expect(limitFor("ems:write").perMinute).toBe(30);
    expect(limitFor("control").perMinute).toBe(30);
  });

  it("treats an unknown scope as a read rather than as unlimited", () => {
    expect(limitFor("something:new").perMinute).toBe(120);
  });

  it("is overridable, and ignores nonsense overrides", () => {
    const prev = process.env.RATE_READ_PER_MIN;
    try {
      process.env.RATE_READ_PER_MIN = "500";
      expect(limitFor("read").perMinute).toBe(500);
      for (const bad of ["0", "-5", "abc", ""]) {
        process.env.RATE_READ_PER_MIN = bad;
        expect(limitFor("read").perMinute).toBe(120);
      }
    } finally {
      if (prev === undefined) delete process.env.RATE_READ_PER_MIN;
      else process.env.RATE_READ_PER_MIN = prev;
    }
  });
});
