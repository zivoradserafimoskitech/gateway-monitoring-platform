// §9.15: the retry policy — "how long until the fourth attempt" as a test
// rather than an argument.
import { describe, it, expect } from "vitest";
import { backoffMs, classify, nextAttemptAt, MAX_ATTEMPTS } from "../api/webhooks/retry";

describe("backoffMs", () => {
  it("doubles from ten seconds", () => {
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(2)).toBe(20_000);
    expect(backoffMs(3)).toBe(40_000);
    expect(backoffMs(4)).toBe(80_000);
  });

  it("caps at an hour, and stays capped for absurd inputs", () => {
    expect(backoffMs(20)).toBe(3_600_000);
    expect(backoffMs(2000)).toBe(3_600_000);
    expect(Number.isFinite(backoffMs(2000))).toBe(true);
  });

  it("treats attempt zero as the first attempt", () => {
    expect(backoffMs(0)).toBe(10_000);
  });
});

describe("nextAttemptAt", () => {
  const now = new Date("2026-03-10T00:00:00Z");

  it("spreads retries by ±25% so one dead endpoint does not stampede", () => {
    const lo = nextAttemptAt(1, now, () => 0).getTime() - now.getTime();
    const hi = nextAttemptAt(1, now, () => 1).getTime() - now.getTime();
    expect(lo).toBe(7_500);
    expect(hi).toBe(12_500);
  });

  it("is the plain backoff at the midpoint", () => {
    expect(nextAttemptAt(3, now, () => 0.5).getTime() - now.getTime()).toBe(40_000);
  });
});

describe("classify", () => {
  it("2xx is delivered", () => {
    expect(classify(200, null, 1)).toEqual({ kind: "delivered", status: 200 });
    expect(classify(204, null, 1)).toEqual({ kind: "delivered", status: 204 });
  });

  it("5xx and network errors retry", () => {
    expect(classify(500, null, 1).kind).toBe("retry");
    expect(classify(503, null, 1).kind).toBe("retry");
    expect(classify(null, "ECONNREFUSED", 1).kind).toBe("retry");
  });

  it("4xx is permanent — the receiver is saying the request is wrong", () => {
    expect(classify(400, null, 1).kind).toBe("dead");
    expect(classify(401, null, 1).kind).toBe("dead");
    expect(classify(404, null, 1).kind).toBe("dead");
    expect(classify(422, null, 1).kind).toBe("dead");
  });

  it("except 408 and 429, which are explicit requests to come back later", () => {
    expect(classify(408, null, 1).kind).toBe("retry");
    expect(classify(429, null, 1).kind).toBe("retry");
  });

  it("gives up at the attempt limit", () => {
    expect(classify(500, null, MAX_ATTEMPTS - 1).kind).toBe("retry");
    const last = classify(500, null, MAX_ATTEMPTS);
    expect(last.kind).toBe("dead");
    expect(last.kind === "dead" && last.error).toContain("gave up");
  });

  it("describes a failure with no response at all", () => {
    const r = classify(null, null, 1);
    expect(r.kind).toBe("retry");
    expect(r.kind === "retry" && r.error).toBe("no response");
  });

  it("3xx is not a receipt — fetch follows redirects, so one that surfaces is a misconfiguration", () => {
    // Retried rather than buried: a redirect that reached us unfollowed says
    // something about the endpoint, and calling it "delivered" would tell the
    // subscriber their integration is healthy when nothing received the body.
    expect(classify(302, null, 1).kind).toBe("retry");
  });
});
