// audit wave 6: REST validation + persistence of ems_plans min_soc/max_soc.
// PUT /api/v1/devices/:id/ems-plan accepts optional minSoc/maxSoc — each in
// [0,100], minSoc < maxSoc when both present, null/absent = no limit — and
// GET returns them. Everything external (API key, DB) is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({
  apiKey: null as {
    id: number;
    name: string;
    role: string;
    orgId: number | null;
    scopes: string[] | null;
    expiresAt: Date | null;
  } | null,
  deviceFound: true,
  executed: [] as Array<{ sql: string; params: unknown[] }>,
  selectRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../queries/connection", () => ({ getDb: () => fakeDb() }));
vi.mock("../lib/api-keys", () => ({ lookupApiKey: async () => state.apiKey }));
vi.mock("../telemetry", () => ({ getTelemetryStore: () => ({ latest: async () => null }) }));

import { restV1 } from "./v1";

const dialect = new MySqlDialect();

function fakeDb(): unknown {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (state.deviceFound ? [{ id: 1 }] : []),
        }),
      }),
    }),
    execute: async (query: unknown) => {
      try {
        const q = dialect.sqlToQuery(query as never);
        state.executed.push({ sql: q.sql, params: q.params });
      } catch {
        state.executed.push({ sql: String(query), params: [] });
      }
      if (/^select/i.test(state.executed[state.executed.length - 1].sql)) {
        return [state.selectRows, []];
      }
      if (/^insert/i.test(state.executed[state.executed.length - 1].sql)) {
        return [{ insertId: 4242 }, []];
      }
      return [{ affectedRows: 0 }, []];
    },
  };
}

async function put(path: string, body: unknown): Promise<Response> {
  return restV1.request(path, {
    method: "PUT",
    headers: { authorization: "Bearer etk_test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<Response> {
  return restV1.request(path, { headers: { authorization: "Bearer etk_test" } });
}

const FROM = "2026-08-17T10:00:00.000Z";
const TO = "2026-08-17T12:00:00.000Z";
const validPlan = (over: Record<string, unknown> = {}) => ({
  validFrom: FROM,
  validTo: TO,
  source: "volttrade",
  setpoints: [{ ts: FROM, kw: 10 }],
  ...over,
});

beforeEach(() => {
  state.apiKey = { id: 7, name: "test", role: "operator", orgId: 1, scopes: ["read", "control", "ems:write"], expiresAt: null };
  state.deviceFound = true;
  state.executed = [];
  state.selectRows = [];
});

function insertCall(): { sql: string; params: unknown[] } {
  const ins = state.executed.find((e) => /^insert/i.test(e.sql));
  if (!ins) throw new Error(`no INSERT executed; saw: ${state.executed.map((e) => e.sql).join(" | ")}`);
  return ins;
}

describe("PUT /devices/:id/ems-plan — SoC limit validation (audit wave 6)", () => {
  it("minSoc > maxSoc → 400", async () => {
    const res = await put("/devices/1/ems-plan", validPlan({ minSoc: 80, maxSoc: 20 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/minSoc must be less than maxSoc/);
    expect(state.executed.some((e) => /^insert/i.test(e.sql))).toBe(false); // rejected before any insert
  });

  it("minSoc == maxSoc → 400 (must be strictly less)", async () => {
    const res = await put("/devices/1/ems-plan", validPlan({ minSoc: 50, maxSoc: 50 }));
    expect(res.status).toBe(400);
  });

  it("out of range → 400 (−1, 101, 150, 100.0001; non-number too)", async () => {
    // (NaN/Infinity can't arrive as JSON numbers — they'd be null/absent.)
    for (const over of [{ minSoc: -1 }, { minSoc: 101 }, { maxSoc: 150 }, { maxSoc: 100.0001 }, { minSoc: "50" }]) {
      const res = await put("/devices/1/ems-plan", validPlan(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
    expect(state.executed.some((e) => /^insert/i.test(e.sql))).toBe(false);
  });

  it("only minSoc present → 200, persisted, returned (maxSoc null)", async () => {
    const res = await put("/devices/1/ems-plan", validPlan({ minSoc: 20 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { planId: number; minSoc: number | null; maxSoc: number | null };
    expect(body).toMatchObject({ planId: 4242, status: "active", minSoc: 20, maxSoc: null });
    const ins = insertCall();
    expect(ins.sql).toContain("min_soc");
    expect(ins.sql).toContain("max_soc");
    expect(ins.params).toContain(20);
    expect(ins.params).toContain(null);
  });

  it("only maxSoc present → 200; both present valid → 200; absent → 200 with nulls (regression)", async () => {
    for (const [over, min, max] of [
      [{ maxSoc: 90 }, null, 90],
      [{ minSoc: 10, maxSoc: 90 }, 10, 90],
      [{}, null, null],
      [{ minSoc: null, maxSoc: null }, null, null],
    ] as Array<[Record<string, unknown>, number | null, number | null]>) {
      state.executed = [];
      const res = await put("/devices/1/ems-plan", validPlan(over));
      expect(res.status, JSON.stringify(over)).toBe(200);
      const body = (await res.json()) as { minSoc: number | null; maxSoc: number | null };
      expect(body.minSoc).toBe(min);
      expect(body.maxSoc).toBe(max);
      const ins = insertCall();
      expect(ins.params).toContain(min === null ? null : min);
      expect(ins.params).toContain(max === null ? null : max);
    }
  });

  it("boundary values 0 and 100 are accepted", async () => {
    const res = await put("/devices/1/ems-plan", validPlan({ minSoc: 0, maxSoc: 100 }));
    expect(res.status).toBe(200);
  });
});

describe("GET /devices/:id/ems-plan — returns SoC limits", () => {
  it("active plan row carries minSoc/maxSoc through to the response", async () => {
    state.selectRows = [
      {
        id: 9,
        meterId: 1,
        orgId: 1,
        source: "volttrade",
        validFrom: FROM,
        validTo: TO,
        setpoints: JSON.stringify([{ ts: FROM, kw: 10 }]),
        minSoc: 20,
        maxSoc: 90,
        status: "active",
        createdAt: FROM,
      },
    ];
    const res = await get("/devices/1/ems-plan");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { minSoc: number; maxSoc: number } };
    expect(body.plan.minSoc).toBe(20);
    expect(body.plan.maxSoc).toBe(90);
    const sel = state.executed.find((e) => /^select/i.test(e.sql));
    expect(sel?.sql).toContain("min_soc");
    expect(sel?.sql).toContain("max_soc");
  });
});
