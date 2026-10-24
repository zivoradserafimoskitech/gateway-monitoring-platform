// POST /api/v1/devices/:id/commands + helpers. DB, API keys and the control
// chokepoint are mocked; this tests scopes, validation and status mapping.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scopes: ["read", "control", "control:write"] as string[] | null,
  meter: { id: 7, name: "BESS", model: "X", gatewayId: 1, orgId: 3 } as Record<string, unknown> | null,
  exec: null as null | (() => unknown),
}));

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (state.meter ? [state.meter] : []) }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
}));
vi.mock("../lib/api-keys", () => ({
  lookupApiKey: async () => ({ id: 1, name: "volttrade", role: "admin", orgId: 3, scopes: state.scopes, expiresAt: null }),
}));
vi.mock("./rate-limit-store", () => ({
  consume: async () => ({ allowed: true, next: { tokens: 1, updatedAt: new Date() }, remaining: 1, retryAfterSec: 0, limit: 120 }),
}));
vi.mock("../telemetry", () => ({ getTelemetryStore: () => ({}) }));
vi.mock("../webhooks/dispatch", () => ({ emit: async () => 0 }));
vi.mock("../control/execute", () => {
  class ControlError extends Error {}
  return {
    ControlError,
    controllableForModel: async () => ({}),
    verificationForModel: async () => null,
    executeControl: async () => ({ status: "preview", detail: "would write" }),
    executeAndLog: async () => {
      if (state.exec) return state.exec();
      return { status: "ok", detail: "verified", commandId: 99 };
    },
  };
});

import { restV1, endpointScope } from "./v1";
import { httpStatusFor, parseCommandBody } from "./v1-device-control";
import { ControlError } from "../control/execute";

function post(body: unknown) {
  return restV1.request("/devices/7/commands", {
    method: "POST",
    headers: { authorization: "Bearer etk_x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.scopes = ["read", "control", "control:write"];
  state.meter = { id: 7, name: "BESS", model: "X", gatewayId: 1, orgId: 3 };
  state.exec = null;
});

describe("parseCommandBody", () => {
  it("accepts key or the VoltTrade point alias and echoes externalId", () => {
    expect(parseCommandBody({ point: "p_limit_pct", value: 50, commandId: 12 })).toEqual({ key: "p_limit_pct", value: 50, externalId: "12", dryRun: false });
  });
  it("rejects bad input", () => {
    expect(parseCommandBody(null)).toHaveProperty("error");
    expect(parseCommandBody({ key: "a b", value: 1 })).toHaveProperty("error");
    expect(parseCommandBody({ key: "k", value: "1" })).toHaveProperty("error");
    expect(parseCommandBody({ key: "k", value: 1, externalId: "x".repeat(65) })).toHaveProperty("error");
  });
  it("maps statuses to HTTP", () => {
    expect([httpStatusFor("ok"), httpStatusFor("sent"), httpStatusFor("rejected"), httpStatusFor("failed")]).toEqual([200, 202, 409, 502]);
  });
  it("requires control:write on POST commands", () => {
    expect(endpointScope("POST", "/api/v1/devices/5/commands")).toBe("control:write");
    expect(endpointScope("GET", "/api/v1/commands/5")).toBeNull();
  });
});

describe("POST /devices/:id/commands", () => {
  it("403 without control:write", async () => {
    state.scopes = ["read", "control"];
    expect((await post({ key: "k", value: 1 })).status).toBe(403);
  });
  it("404 for a device in another org", async () => {
    state.meter = null;
    expect((await post({ key: "k", value: 1 })).status).toBe(404);
  });
  it("200 with verified read-back", async () => {
    const r = await post({ key: "k", value: 1, externalId: "vt-1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ commandId: 99, externalId: "vt-1", status: "ok", readback: "verified" });
  });
  it("202 when read-back is pending", async () => {
    state.exec = () => ({ status: "sent", detail: "pending", commandId: 5 });
    const r = await post({ key: "k", value: 1 });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ readback: "pending" });
  });
  it("409 when a safety gate refuses", async () => {
    state.exec = () => {
      throw new ControlError("emergency stop");
    };
    const r = await post({ key: "k", value: 1 });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ status: "rejected" });
  });
  it("dry run previews without logging", async () => {
    const r = await post({ key: "k", value: 1, dryRun: true });
    expect(await r.json()).toMatchObject({ status: "preview", commandId: null });
  });
});
