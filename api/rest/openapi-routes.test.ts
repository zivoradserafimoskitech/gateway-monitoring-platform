// §9.13: the test that makes a hand-written OpenAPI document a contract rather
// than documentation.
//
// It walks the routes Hono has actually registered and compares them with the
// spec in both directions. A route added without a spec entry fails here, and
// so does a spec entry for a route that no longer exists — which is the one
// that actually bites, because an integrator generates a client from it and
// discovers the 404 in production.
import { describe, expect, it, vi } from "vitest";

vi.mock("../queries/connection", () => ({ getDb: () => ({}) }));
vi.mock("../lib/api-keys", () => ({ lookupApiKey: async () => null }));
vi.mock("../telemetry", () => ({ getTelemetryStore: () => ({}) }));

import { restV1 } from "./v1";
import { openApiSpec } from "./openapi";

/** Hono writes params as :id; OpenAPI writes them as {id}. */
function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

interface HonoRoute {
  path: string;
  method: string;
}

function registered(): Array<{ path: string; method: string }> {
  const routes = (restV1 as unknown as { routes: HonoRoute[] }).routes;
  return routes
    // The auth/rate-limit middleware registers as ALL "*" — it is not an
    // endpoint and has nothing to describe.
    .filter((r) => r.method !== "ALL" && r.path !== "*")
    .map((r) => ({ path: toOpenApiPath(r.path), method: r.method.toLowerCase() }));
}

describe("OpenAPI spec", () => {
  const spec = openApiSpec();
  const paths = spec.paths as Record<string, Record<string, unknown>>;

  it("describes every registered route", () => {
    const missing: string[] = [];
    for (const r of registered()) {
      if (!paths[r.path] || !paths[r.path][r.method]) missing.push(`${r.method.toUpperCase()} ${r.path}`);
    }
    expect(missing).toEqual([]);
  });

  it("describes no route that does not exist", () => {
    const live = new Set(registered().map((r) => `${r.method} ${r.path}`));
    const extra: string[] = [];
    for (const [path, ops] of Object.entries(paths)) {
      for (const method of Object.keys(ops)) {
        if (!live.has(`${method} ${path}`)) extra.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(extra).toEqual([]);
  });

  it("finds a non-trivial number of routes, so an empty walk cannot pass silently", () => {
    // Without this, a change that made restV1.routes unreadable would make
    // both checks above vacuously true.
    expect(registered().length).toBeGreaterThanOrEqual(8);
  });

  it("every operation says what a 429 means, because every route can return one", () => {
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const responses = (op as { responses: Record<string, unknown> }).responses;
        expect(responses["429"], `${method.toUpperCase()} ${path}`).toBeDefined();
        expect(responses["401"], `${method.toUpperCase()} ${path}`).toBeDefined();
      }
    }
  });

  it("declares bearer auth globally", () => {
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.openapi).toBe("3.1.0");
  });
});
