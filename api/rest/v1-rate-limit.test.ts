// §9.13: the rate limiter as the REST layer sees it — which scope a route is
// charged against, what a rejection looks like on the wire, and that the
// headers are present whether or not the request passed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  apiKey: null as {
    id: number;
    name: string;
    role: string;
    orgId: number | null;
    scopes: string[] | null;
    expiresAt: Date | null;
  } | null,
  calls: [] as Array<{ keyId: number; scope: string }>,
  allow: true,
}));

// A chainable thenable: every builder method returns itself, and awaiting it
// anywhere in the chain yields one row. These tests are about which scope a
// route charges, not about what it queries, so the shape of the query builder
// is deliberately not something they assert on.
vi.mock("../queries/connection", () => {
  const row = [{ id: 1 }];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) {
    chain[m] = () => chain;
  }
  const settled = Promise.resolve(row);
  chain.then = settled.then.bind(settled);
  chain.catch = settled.catch.bind(settled);
  chain.finally = settled.finally.bind(settled);
  return { getDb: () => chain };
});
vi.mock("../lib/api-keys", () => ({ lookupApiKey: async () => state.apiKey }));
vi.mock("../telemetry", () => ({
  getTelemetryStore: () => ({ latest: async () => null, metricSeries: async () => [] }),
}));
vi.mock("./rate-limit-store", () => ({
  consume: async (keyId: number, scope: string) => {
    state.calls.push({ keyId, scope });
    return state.allow
      ? { allowed: true, next: { tokens: 5, updatedAt: new Date() }, remaining: 5, retryAfterSec: 0, limit: 120 }
      : { allowed: false, next: { tokens: 0, updatedAt: new Date() }, remaining: 0, retryAfterSec: 7, limit: 120 };
  },
}));

import { restV1 } from "./v1";

function keyWith(scopes: string[] | null, role = "viewer"): void {
  state.apiKey = { id: 42, name: "test", role, orgId: 1, scopes, expiresAt: null };
}

const get = (path: string) => restV1.request(path, { headers: { authorization: "Bearer etk_test" } });

beforeEach(() => {
  state.calls = [];
  state.allow = true;
  keyWith(["read", "telemetry:read", "control", "ems:write"], "admin");
});

describe("REST rate limiting", () => {
  it("charges an ordinary GET against the read scope", async () => {
    await get("/sites");
    expect(state.calls).toEqual([{ keyId: 42, scope: "read" }]);
  });

  it("charges the telemetry route against telemetry:read, not read", async () => {
    // The whole point of per-scope budgets: a range scan must not be paid for
    // out of the same allowance as a device listing.
    await get("/devices/1/telemetry?from=2026-03-10T00:00:00Z&to=2026-03-10T01:00:00Z&keys=activePowerKw");
    expect(state.calls).toEqual([{ keyId: 42, scope: "telemetry:read" }]);
  });

  it("charges an EMS plan push against ems:write", async () => {
    await restV1.request("/devices/1/ems-plan", {
      method: "PUT",
      headers: { authorization: "Bearer etk_test", "content-type": "application/json" },
      body: "{}",
    });
    expect(state.calls).toEqual([{ keyId: 42, scope: "ems:write" }]);
  });

  it("returns 429 with Retry-After when the bucket is empty", async () => {
    state.allow = false;
    const res = await get("/sites");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.retryAfter).toBe(7);
    expect(body.error).toContain("read");
  });

  it("reports the budget on a successful request too, so a client can pace itself", async () => {
    const res = await get("/sites");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("120");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("5");
    expect(res.headers.get("X-RateLimit-Scope")).toBe("read");
  });

  it("never charges an unauthenticated request", async () => {
    // Otherwise anyone could drain a key's quota by guessing at its id.
    state.apiKey = null;
    const res = await get("/sites");
    expect(res.status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it("never charges a request rejected for scope", async () => {
    keyWith(["read"]);
    const res = await get("/devices/1/telemetry?from=2026-03-10T00:00:00Z&to=2026-03-10T01:00:00Z&keys=activePowerKw");
    expect(res.status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("serves the spec, and charges it as a read", async () => {
    const res = await get("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(5);
    expect(state.calls).toEqual([{ keyId: 42, scope: "read" }]);
  });
});
