// audit wave4 (Task 2): dual-counter login lockout.
// The old `${email}|${ip}` counter let credential spraying (one host, many
// accounts) and distributed guessing (one account, many hosts) through —
// every pair was distinct, so no counter ever reached 5. Now a failure is
// recorded against BOTH `id:<email>` and `ip:<ip>`, and a login is rejected
// when EITHER key is locked. These tests pin the three attack scenarios plus
// the map bound.
import { describe, it, expect, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { __loginLimiterForTests as limiter } from "./auth";

function req(ip: string): Request {
  return new Request("http://localhost/api/trpc", { headers: { "x-forwarded-for": ip } });
}

async function expectLocked(email: string, ip: string): Promise<void> {
  try {
    await limiter.loginThrottle(email, req(ip));
    expect.unreachable(`expected ${email}@${ip} to be locked out`);
  } catch (e) {
    expect(e).toBeInstanceOf(TRPCError);
    expect((e as TRPCError).code).toBe("TOO_MANY_REQUESTS");
  }
}

async function expectAllowed(email: string, ip: string): Promise<void> {
  await limiter.loginThrottle(email, req(ip)); // resolves (no lockout)
}

beforeEach(() => {
  limiter.attempts.clear();
});

describe("keysFor", () => {
  it("builds identity + ip keys, lowercasing the email", () => {
    expect(limiter.keysFor("Alice@Example.com", "10.0.0.1")).toEqual(["id:alice@example.com", "ip:10.0.0.1"]);
  });
});

describe("dual-counter lockout", () => {
  it("credential spray: three accounts from one IP locks the IP", async () => {
    const ip = "203.0.113.9";
    // 6 failures spread across 3 distinct accounts — every old-style
    // `email|ip` pair would have stayed at 2, far below the threshold.
    for (const email of ["a@x.test", "b@x.test", "c@x.test"]) {
      limiter.recordLoginFailure(email, req(ip));
      limiter.recordLoginFailure(email, req(ip));
    }
    expect(limiter.attempts.get(`ip:${ip}`)!.lockedUntil).toBeGreaterThan(Date.now());
    // ...so a FOURTH account from the same host is rejected before any DB work.
    await expectLocked("d@x.test", ip);
    await expectLocked("a@x.test", ip);
    // The sprayed identities themselves only have 2 failures — from a clean
    // host they are NOT locked (progressive delay only).
    const idRec = limiter.attempts.get("id:a@x.test")!;
    expect(idRec.failures).toHaveLength(2);
    expect(idRec.lockedUntil).toBeLessThanOrEqual(Date.now());
  });

  it("distributed guessing: one account from three IPs locks the identity", async () => {
    const email = "victim@x.test";
    // 6 failures from 3 distinct source IPs — no old-style pair repeats enough.
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
      limiter.recordLoginFailure(email, req(ip));
      limiter.recordLoginFailure(email, req(ip));
    }
    expect(limiter.attempts.get(`id:${email}`)!.lockedUntil).toBeGreaterThan(Date.now());
    // A brand-new source IP does not help the attacker.
    await expectLocked(email, "198.51.100.4");
    // Each individual IP only saw 2 failures — not locked for other users.
    const ipRec = limiter.attempts.get("ip:198.51.100.1")!;
    expect(ipRec.failures).toHaveLength(2);
    expect(ipRec.lockedUntil).toBeLessThanOrEqual(Date.now());
  });

  it("an unrelated user on an unrelated host stays unaffected", async () => {
    const attackerIp = "192.0.2.66";
    for (let i = 0; i < 6; i++) limiter.recordLoginFailure("target@x.test", req(attackerIp));
    await expectLocked("target@x.test", attackerIp);
    // Neither the identity nor the IP key of the innocent user was touched:
    // no lockout, no failure count, no delay.
    await expectAllowed("innocent@x.test", "203.0.113.200");
    expect(limiter.attempts.has("id:innocent@x.test")).toBe(false);
    expect(limiter.attempts.has("ip:203.0.113.200")).toBe(false);
    // Successful login clears BOTH counters for the pair.
    limiter.recordLoginFailure("innocent@x.test", req("203.0.113.200"));
    limiter.clearLoginFailures("innocent@x.test", req("203.0.113.200"));
    expect(limiter.attempts.has("id:innocent@x.test")).toBe(false);
    expect(limiter.attempts.has("ip:203.0.113.200")).toBe(false);
  });
});

describe("loginAttempts map bound", () => {
  it("stays at or below the cap under a fabricated-identity flood", () => {
    const flood = limiter.MAX + 500;
    for (let i = 0; i < flood; i++) {
      limiter.recordLoginFailure(`user${i}@spray.test`, req(`10.${(i >> 8) & 255}.${i & 255}.1`));
    }
    expect(limiter.attempts.size).toBeLessThanOrEqual(limiter.MAX);
    // Oldest entries were evicted; the most recent ones survive.
    expect(limiter.attempts.has("id:user0@spray.test")).toBe(false);
    expect(limiter.attempts.has(`id:user${flood - 1}@spray.test`)).toBe(true);
  });
});
