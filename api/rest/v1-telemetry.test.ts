// audit wave 4 (Task 4): tests for GET /api/v1/devices/:id/telemetry and the
// NULL-scopes read-only flip. Everything external (API-key lookup, metadata
// DB, telemetry store) is mocked — no real database is touched.
//
// Covered:
//  - metric-key whitelist rejects (injection attempts, empty, >64 chars)
//  - full UTC-aligned grid materialization (gap → null values + samples:0;
//    a measured ZERO is preserved and never confused with "no data")
//  - scope enforcement: NULL-scopes key → 403 on /telemetry and PUT ems-plan;
//    read-only key → 403 on PUT ems-plan; control-without-ems:write → 403;
//    role does not imply scope (admin role without ems:write → 403);
//    telemetry:read key → 200; ems:write key → not 403 on the scope check
//  - store-level whitelist defence in depth (MySQL + Timescale), column vs
//    values_json extraction, non-empty-bucket mapping
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// ─── Shared mock state (hoisted so vi.mock factories can reach it) ──────────
const state = vi.hoisted(() => ({
  apiKey: null as {
    id: number;
    name: string;
    role: string;
    orgId: number | null;
    scopes: string[] | null;
    expiresAt: Date | null;
  } | null,
  db: null as unknown,
  deviceFound: true,
  metricRows: [] as Array<{ bucketStartSec: number; values: Record<string, number | null>; samples: number }>,
  metricCalls: [] as Array<{ meterId: number; from: Date; to: Date; bucketSec: number; keys: string[] }>,
}));

vi.mock("../queries/connection", () => ({ getDb: () => state.db }));

vi.mock("../lib/api-keys", () => ({ lookupApiKey: async () => state.apiKey }));

vi.mock("../telemetry", () => ({
  getTelemetryStore: () => ({
    metricSeries: async (meterId: number, from: Date, to: Date, bucketSec: number, keys: string[]) => {
      state.metricCalls.push({ meterId, from, to, bucketSec, keys });
      return state.metricRows;
    },
    latest: async () => null,
  }),
}));

// Imported AFTER the mocks are registered.
import { restV1, endpointScope, requiredScope } from "./v1";
import { MySqlTelemetryStore } from "../telemetry/mysql-store";
import { TimescaleTelemetryStore } from "../telemetry/timescale-store";
import { METRIC_KEY_RE } from "../telemetry/types";

function deviceDb(found: boolean): unknown {
  // The only metadata query these routes run is the org-scoped device lookup:
  // db.select({...}).from(meters).where(...).limit(1)
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (found ? [{ id: 1 }] : []),
        }),
      }),
    }),
  };
}

function keyWith(scopes: string[] | null, role = "viewer"): void {
  state.apiKey = { id: 7, name: "test", role, orgId: 1, scopes, expiresAt: null };
}

async function get(path: string): Promise<Response> {
  return restV1.request(path, { headers: { authorization: "Bearer etk_test" } });
}

async function put(path: string, body?: unknown): Promise<Response> {
  return restV1.request(path, {
    method: "PUT",
    headers: { authorization: "Bearer etk_test", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface TelemetryResponse {
  deviceId: number;
  from: string;
  to: string;
  bucketMin: number;
  keys: string[];
  buckets: Array<{ ts: string; values: Record<string, number | null>; samples: number }>;
  error?: string;
}

const FROM = "2026-08-14T10:00:00.000Z";
const TO = "2026-08-14T10:30:00.000Z";
const T0 = Math.floor(Date.parse(FROM) / 1000); // 1755172800 area; aligned to 15 min
const Q = `from=${FROM}&to=${TO}&keys=activePowerKw,socPercent&bucketMin=15`;

beforeEach(() => {
  state.apiKey = null;
  state.db = deviceDb(true);
  state.metricRows = [];
  state.metricCalls = [];
});

describe("GET /devices/:id/telemetry — parameter validation", () => {
  beforeEach(() => keyWith(["read", "telemetry:read"]));

  it("200 with the full consecutive UTC-aligned grid", async () => {
    const res = await get(`/devices/1/telemetry?${Q}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TelemetryResponse;
    expect(body.deviceId).toBe(1);
    expect(body.bucketMin).toBe(15);
    expect(body.keys).toEqual(["activePowerKw", "socPercent"]);
    expect(body.buckets).toHaveLength(2);
    expect(body.buckets[0].ts).toBe(FROM);
    expect(body.buckets[1].ts).toBe("2026-08-14T10:15:00.000Z");
    // No store rows → both buckets present with nulls + samples:0.
    for (const b of body.buckets) {
      expect(b.values).toEqual({ activePowerKw: null, socPercent: null });
      expect(b.samples).toBe(0);
    }
    // store saw bucketSec (not minutes) and the parsed key list
    expect(state.metricCalls).toHaveLength(1);
    expect(state.metricCalls[0].bucketSec).toBe(900);
    expect(state.metricCalls[0].keys).toEqual(["activePowerKw", "socPercent"]);
  });

  it("grid materialization: data bucket keeps measured values, gap is null+samples:0, measured ZERO is not null", async () => {
    state.metricRows = [
      { bucketStartSec: T0, values: { activePowerKw: 0, socPercent: 42.5 }, samples: 3 },
    ];
    const res = await get(`/devices/1/telemetry?${Q}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TelemetryResponse;
    expect(body.buckets[0]).toEqual({
      ts: FROM,
      values: { activePowerKw: 0, socPercent: 42.5 }, // measured zero stays 0
      samples: 3,
    });
    expect(body.buckets[1]).toEqual({
      ts: "2026-08-14T10:15:00.000Z",
      values: { activePowerKw: null, socPercent: null },
      samples: 0,
    });
  });

  it("grid is floored/ceiled to UTC bucket boundaries for unaligned from/to", async () => {
    const res = await get(
      `/devices/1/telemetry?from=2026-08-14T10:07:00.000Z&to=2026-08-14T10:16:00.000Z&keys=activePowerKw&bucketMin=15`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TelemetryResponse;
    // Same grid convention as /energy: floor(from) … ceil(to) — the bucket
    // CONTAINING `to` (10:15–10:30) is the last one.
    expect(body.buckets.map((b) => b.ts)).toEqual([
      "2026-08-14T10:00:00.000Z",
      "2026-08-14T10:15:00.000Z",
    ]);
  });

  it("bucketMin defaults to 15 and is passed to the store as seconds", async () => {
    const res = await get(`/devices/1/telemetry?from=${FROM}&to=${TO}&keys=activePowerKw`);
    expect(res.status).toBe(200);
    expect(state.metricCalls[0].bucketSec).toBe(900);
  });

  it("400 on whitelist violations: injection, semicolon, empty, 65 chars", async () => {
    const bad = ['"; DROP TABLE telemetry;--', "a;b", "", "x".repeat(65), "1startsWithDigit", "with space"];
    for (const k of bad) {
      const res = await get(`/devices/1/telemetry?from=${FROM}&to=${TO}&keys=${encodeURIComponent(k)}&bucketMin=15`);
      expect(res.status, `key ${JSON.stringify(k)}`).toBe(400);
      const body = (await res.json()) as TelemetryResponse;
      expect(body.error).toMatch(/invalid metric key|keys query param/);
    }
    expect(state.metricCalls).toHaveLength(0); // store never reached
  });

  it("400 on >16 keys, missing keys, bad bucketMin, range >31d, from>=to, unparsable dates", async () => {
    const manyKeys = Array.from({ length: 17 }, (_, i) => `k${i}`).join(",");
    const cases = [
      `/devices/1/telemetry?from=${FROM}&to=${TO}&keys=${manyKeys}`,
      `/devices/1/telemetry?from=${FROM}&to=${TO}`,
      `/devices/1/telemetry?from=${FROM}&to=${TO}&keys=activePowerKw&bucketMin=0`,
      `/devices/1/telemetry?from=${FROM}&to=${TO}&keys=activePowerKw&bucketMin=1441`,
      `/devices/1/telemetry?from=${FROM}&to=${TO}&keys=activePowerKw&bucketMin=2.5`,
      `/devices/1/telemetry?from=2026-07-01T00:00:00.000Z&to=${TO}&keys=activePowerKw`,
      `/devices/1/telemetry?from=${TO}&to=${FROM}&keys=activePowerKw`,
      `/devices/1/telemetry?from=not-a-date&to=${TO}&keys=activePowerKw`,
    ];
    for (const p of cases) {
      const res = await get(p);
      expect(res.status, p).toBe(400);
    }
    expect(state.metricCalls).toHaveLength(0);
  });

  it("boundary values pass: 16 keys, bucketMin 1 and 1440", async () => {
    const keys16 = Array.from({ length: 16 }, (_, i) => `k${i}`).join(",");
    expect((await get(`/devices/1/telemetry?from=${FROM}&to=${TO}&keys=${keys16}&bucketMin=1`)).status).toBe(200);
    expect((await get(`/devices/1/telemetry?from=${FROM}&to=${TO}&keys=activePowerKw&bucketMin=1440`)).status).toBe(200);
  });

  it("404 for a device outside the key's org", async () => {
    state.db = deviceDb(false);
    const res = await get(`/devices/1/telemetry?${Q}`);
    expect(res.status).toBe(404);
    expect(state.metricCalls).toHaveLength(0);
  });
});

describe("scope enforcement (NULL = read-only flip, constraint #3)", () => {
  it("NULL-scopes legacy key: GET read routes still pass the coarse check…", async () => {
    keyWith(null);
    // /latest is a plain read route — NULL key must keep working there.
    const res = await get(`/devices/1/latest`);
    expect(res.status).toBe(200);
  });

  it("NULL-scopes legacy key → 403 on /telemetry (telemetry:read)", async () => {
    keyWith(null);
    const res = await get(`/devices/1/telemetry?${Q}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("telemetry:read");
    expect(state.metricCalls).toHaveLength(0);
  });

  it("NULL-scopes legacy key → 403 on PUT ems-plan (control)", async () => {
    keyWith(null);
    const res = await put(`/devices/1/ems-plan`, { validFrom: FROM, validTo: TO, setpoints: [{ ts: FROM, kw: 0 }] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("control");
  });

  it("read-only key [read] → 403 on PUT ems-plan and on /telemetry", async () => {
    keyWith(["read"]);
    expect((await put(`/devices/1/ems-plan`, { validFrom: FROM, validTo: TO, setpoints: [{ ts: FROM, kw: 0 }] })).status).toBe(403);
    expect((await get(`/devices/1/telemetry?${Q}`)).status).toBe(403);
  });

  it("role does not imply scope: admin-role key with [read, control] but no ems:write → 403 on PUT ems-plan", async () => {
    keyWith(["read", "control"], "admin");
    const res = await put(`/devices/1/ems-plan`, { validFrom: FROM, validTo: TO, setpoints: [{ ts: FROM, kw: 0 }] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("ems:write");
  });

  it("key with [read, control, ems:write] passes the scope check on PUT ems-plan (fails later on a missing body, not 403)", async () => {
    keyWith(["read", "control", "ems:write"], "operator");
    const res = await put(`/devices/1/ems-plan`); // no JSON body → 400 from the handler
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/JSON body/);
  });

  it("key with [read, telemetry:read] can GET /telemetry but not PUT ems-plan", async () => {
    keyWith(["read", "telemetry:read"]);
    expect((await get(`/devices/1/telemetry?${Q}`)).status).toBe(200);
    expect((await put(`/devices/1/ems-plan`, {})).status).toBe(403);
  });

  it("unauthenticated request → 401", async () => {
    state.apiKey = null;
    expect((await get(`/devices/1/telemetry?${Q}`)).status).toBe(401);
  });
});

describe("scope resolution helpers", () => {
  it("requiredScope: GET → read, everything else → control", () => {
    expect(requiredScope("GET")).toBe("read");
    expect(requiredScope("put")).toBe("control");
    expect(requiredScope("DELETE")).toBe("control");
  });

  it("endpointScope layers ems:write / telemetry:read on the right routes only", () => {
    expect(endpointScope("PUT", "/api/v1/devices/42/ems-plan")).toBe("ems:write");
    expect(endpointScope("GET", "/api/v1/devices/42/ems-plan")).toBeNull();
    expect(endpointScope("GET", "/api/v1/devices/42/telemetry")).toBe("telemetry:read");
    expect(endpointScope("GET", "/devices/42/telemetry")).toBe("telemetry:read");
    expect(endpointScope("GET", "/api/v1/devices/42/energy")).toBeNull();
    expect(endpointScope("POST", "/api/v1/devices/42/telemetry")).toBeNull();
  });
});

describe("store implementations — whitelist defence in depth", () => {
  const badKeys = ['"; DROP TABLE telemetry;--', "a;b", "", "x".repeat(65)];

  it("METRIC_KEY_RE accepts sane keys and rejects injection", () => {
    for (const ok of ["activePowerKw", "socPercent", "a", "K_1", "x".repeat(64)]) {
      expect(METRIC_KEY_RE.test(ok), ok).toBe(true);
    }
    for (const bad of [...badKeys, "1x", "with space", "with.dot"]) {
      expect(METRIC_KEY_RE.test(bad), bad).toBe(false);
    }
  });

  it("MySQL store rejects bad keys BEFORE touching the db", async () => {
    const execute = vi.fn();
    state.db = { execute };
    const store = new MySqlTelemetryStore();
    for (const k of badKeys) {
      await expect(store.metricSeries(1, new Date(FROM), new Date(TO), 900, [k])).rejects.toThrow(/invalid metric key/);
    }
    await expect(store.metricSeries(1, new Date(FROM), new Date(TO), 0, ["ok"])).rejects.toThrow(/bucketSec/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("MySQL store: column keys use real columns, others json_extract; only returned buckets are mapped", async () => {
    const dialect = new MySqlDialect();
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    state.db = {
      execute: async (q: unknown) => {
        const rendered = dialect.sqlToQuery(q as never);
        capturedSql = rendered.sql;
        capturedParams = rendered.params;
        return [[{ b: 19473952, samples: 3, activePowerKw: 1.5, socPercent: "42.5", voltageL1: null }]];
      },
    };
    const store = new MySqlTelemetryStore();
    const rows = await store.metricSeries(1, new Date(FROM), new Date(TO), 900, ["activePowerKw", "socPercent", "voltageL1"]);
    expect(capturedSql).toContain("avg(active_power_kw)");
    expect(capturedSql).toContain("avg(voltage_l1)");
    expect(capturedSql).toContain("json_extract(values_json, ?)");
    expect(capturedParams).toContain('$."socPercent"');
    expect(capturedSql).not.toContain("DROP");
    expect(rows).toEqual([
      {
        bucketStartSec: 19473952 * 900,
        values: { activePowerKw: 1.5, socPercent: 42.5, voltageL1: null }, // string decimals → numbers; SQL NULL → null
        samples: 3,
      },
    ]);
  });

  it("Timescale store rejects bad keys BEFORE touching the pool", async () => {
    const store = new TimescaleTelemetryStore("postgres://localhost:1/x");
    const query = vi.fn();
    (store as unknown as { pool: { query: unknown } }).pool = { query };
    for (const k of badKeys) {
      await expect(store.metricSeries(1, new Date(FROM), new Date(TO), 900, [k])).rejects.toThrow(/invalid metric key/);
    }
    await expect(store.metricSeries(1, new Date(FROM), new Date(TO), -5, ["ok"])).rejects.toThrow(/bucketSec/);
    expect(query).not.toHaveBeenCalled();
  });

  it("Timescale store: column keys use real columns, others values_json->>; rows map to MetricSeriesBucket", async () => {
    const store = new TimescaleTelemetryStore("postgres://localhost:1/x");
    let capturedSql = "";
    const query = vi.fn(async (text: string) => {
      capturedSql = text;
      return { rows: [{ b: "19473952", samples: 2, activePowerKw: 0, socPercent: 42 }] };
    });
    (store as unknown as { pool: { query: unknown } }).pool = { query };
    const rows = await store.metricSeries(1, new Date(FROM), new Date(TO), 900, ["activePowerKw", "socPercent"]);
    expect(capturedSql).toContain("avg(active_power_kw)");
    expect(capturedSql).toContain("(values_json->>'socPercent')::double precision");
    expect(capturedSql).not.toContain("DROP");
    expect(rows).toEqual([{ bucketStartSec: 19473952 * 900, values: { activePowerKw: 0, socPercent: 42 }, samples: 2 }]);
  });

  it("both stores return [] for an empty key list without querying", async () => {
    const execute = vi.fn();
    state.db = { execute };
    const my = new MySqlTelemetryStore();
    expect(await my.metricSeries(1, new Date(FROM), new Date(TO), 900, [])).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    const ts = new TimescaleTelemetryStore("postgres://localhost:1/x");
    const query = vi.fn();
    (ts as unknown as { pool: { query: unknown } }).pool = { query };
    expect(await ts.metricSeries(1, new Date(FROM), new Date(TO), 900, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
