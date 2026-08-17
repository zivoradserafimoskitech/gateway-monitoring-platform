// Integration-style tests for the EMS controller tick (v10/P1-9) with the DB,
// telemetry store and the control execution path mocked. These pin the v9
// priority resolution (peak-shaving > fresh ems_plan > schedules), the lazy
// plan-expiry sweep, hysteresis/min-move behavior, SOC guards and the
// never-throw robustness guarantee.
import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// NOTE: @db/schema must be imported dynamically AFTER vi.resetModules() so the
// table objects are identity-equal to the ones the re-imported controller sees.

// ─── Shared mock state (hoisted so vi.mock factories can reach it) ───────────
const state = vi.hoisted(() => ({
  db: null as unknown,
  telemetry: new Map<number, Record<string, number>>(),
  // audit wave 6: per-meter telemetry ts for freshForControl (default: now —
  // fresh). Set an old Date to simulate a stale feed (fail-closed tests).
  telemetryTs: new Map<number, Date>(),
  whitelists: new Map<string, Record<string, { address: number; min: number; max: number }>>(),
  planRows: [] as Array<{
    id: number;
    meterId: number;
    source: string;
    setpoints: unknown;
    minSoc?: number | null;
    maxSoc?: number | null;
  }>,
  calls: [] as Array<{ meterId: number; key: string; value: number; userId: number | null }>,
  executedSql: [] as string[],
}));

vi.mock("../queries/connection", () => ({ getDb: () => state.db }));

// Mock of the store contract incl. audit wave 6 freshForControl: the default
// max age is env.controlTelemetryMaxAgeMs (120000); the mock mirrors it.
const MOCK_MAX_AGE_MS = 120_000;
vi.mock("../telemetry", () => ({
  getTelemetryStore: () => ({
    latest: async (meterId: number) => {
      const values = state.telemetry.get(meterId);
      return values ? { meterId, ts: state.telemetryTs.get(meterId) ?? new Date(), values } : null;
    },
    freshForControl: async (meterId: number, maxAgeMs: number = MOCK_MAX_AGE_MS) => {
      const values = state.telemetry.get(meterId);
      if (!values) return { row: null, fresh: false, ageMs: null };
      const ts = state.telemetryTs.get(meterId) ?? new Date();
      const ageMs = Date.now() - ts.getTime();
      return { row: { meterId, ts, values }, fresh: ageMs <= maxAgeMs, ageMs };
    },
  }),
}));

vi.mock("../control/execute", () => {
  class ControlError extends Error {}
  return {
    ControlError,
    controllableForModel: async (model: string) => state.whitelists.get(model) ?? {},
    executeAndLog: async (meter: { id: number }, key: string, value: number, userId: number | null) => {
      state.calls.push({ meterId: meter.id, key, value, userId });
      return { status: "ok" as const, detail: "mock ok" };
    },
  };
});

// ─── Fake drizzle client ─────────────────────────────────────────────────────
const dialect = new MySqlDialect();

function render(query: unknown): string {
  try {
    const q = dialect.sqlToQuery(query as never);
    return `${q.sql} -- params: ${JSON.stringify(q.params)}`;
  } catch {
    return String(query);
  }
}

/** A select() chain that resolves to the rows registered for the from() table. */
function fakeDb(tables: Map<unknown, unknown[]>): void {
  const makeQuery = (rows: unknown[]): unknown => {
    const q = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(rows).then(onF, onR),
    };
    return q;
  };
  state.db = {
    select: () => ({ from: (table: unknown) => makeQuery(tables.get(table) ?? []) }),
    execute: async (query: unknown) => {
      const text = render(query);
      state.executedSql.push(text);
      // Raw SQL is used for: the lazy plan-expire sweep (update), the active
      // plan select, and plan result tagging (update commands).
      if (/^select/i.test(text)) return [state.planRows, []];
      return [[], []];
    },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────
const BESS = { id: 1, gatewayId: 7, name: "bess-1", model: "BESS-A", siteId: null, orgId: null };
const SOURCE = { id: 2, gatewayId: 7, name: "main", model: "SRC", siteId: null, orgId: null };
const WL_DISCHARGE = { dischargePowerKw: { address: 10, min: 0, max: 100 } };
const WL_BIPOLAR = { chargeDischargePowerKw: { address: 11, min: -100, max: 100 } };

const peakConfig = (over: Record<string, unknown> = {}) => ({
  id: 1,
  siteId: null,
  sourceMeterId: 2,
  bessMeterId: 1,
  thresholdKw: 100,
  hysteresisKw: 10,
  maxDischargeKw: 50,
  enabled: true,
  orgId: null,
  createdAt: new Date(0),
  ...over,
});

const allDaySchedule = (over: Record<string, unknown> = {}) => ({
  id: 5,
  meterId: 1,
  name: "all-day",
  dayOfWeekMask: 0b1111111,
  startMin: 0,
  endMin: 0, // 00:00–00:00 = all day
  mode: "discharge",
  targetKw: 40,
  targetSoc: null,
  enabled: true,
  createdBy: null,
  orgId: null,
  createdAt: new Date(0),
  ...over,
});

/** Fresh schema + table rows wired into the fake DB (call after resetModules). */
async function setup() {
  const schema = await import("@db/schema");
  const tables = new Map<unknown, unknown[]>([
    [schema.meters, [BESS, SOURCE]],
    [schema.gateways, [{ id: 7, siteId: null }]],
    [schema.sites, []],
    [schema.emsPeakShaving, []],
    [schema.emsSchedules, []],
  ]);
  fakeDb(tables);
  return { schema, tables };
}

async function freshTick(): Promise<() => Promise<void>> {
  const mod = await import("./controller");
  return mod.emsTick;
}

beforeEach(() => {
  vi.resetModules(); // fresh lastCmd/peakState maps per test
  state.telemetry.clear();
  state.telemetryTs.clear();
  state.whitelists.clear();
  state.planRows = [];
  state.calls = [];
  state.executedSql = [];
});

test("priority: a firing peak-shaving config stands down plan AND schedule", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsPeakShaving, [peakConfig()]);
  tables.set(schema.emsSchedules, [allDaySchedule()]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);
  state.telemetry.set(2, { activePowerKw: 130 });
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: JSON.stringify([{ ts: new Date(Date.now() - 3600_000).toISOString(), kw: 25 }]),
    },
  ];

  const tick = await freshTick();
  await tick();

  // Only the peak-shaving discharge ran: min(130 − 100, 50, register max 100).
  assert.deepEqual(state.calls, [{ meterId: 1, key: "dischargePowerKw", value: 30, userId: null }]);
  // The lazy expire sweep still ran exactly once, bounded (LIMIT 500).
  const sweep = state.executedSql.find((q) => /update ems_plans/i.test(q));
  assert.ok(sweep, "lazy plan-expire sweep must run every tick");
  assert.match(sweep, /expired/);
  assert.match(sweep, /limit \?/i);
  assert.ok(sweep.includes("500"), `sweep is bounded at 500 rows: ${sweep}`);
});

test("priority: a fresh plan drives the setpoint when peak shaving is idle; schedules stand down", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsPeakShaving, [peakConfig()]);
  tables.set(schema.emsSchedules, [allDaySchedule()]);
  state.whitelists.set("BESS-A", WL_BIPOLAR);
  state.telemetry.set(2, { activePowerKw: 50 }); // below threshold — peak stays idle
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: [{ ts: new Date(Date.now() - 3600_000).toISOString(), kw: -20 }], // charge 20 kW
    },
  ];

  const tick = await freshTick();
  await tick();

  // Bipolar register → charge is written as −20; the due schedule stood down.
  assert.deepEqual(state.calls, [{ meterId: 1, key: "chargeDischargePowerKw", value: -20, userId: null }]);
  // Plan execution tags the command result with plan:<source> for audit.
  const tag = state.executedSql.find((q) => /update commands/i.test(q));
  assert.ok(tag, "plan command result must be tagged");
  assert.match(tag, /plan:/);
});

test("plan with no due setpoint yet leaves the register alone (schedule takes over)", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsSchedules, [allDaySchedule()]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: [{ ts: new Date(Date.now() + 3600_000).toISOString(), kw: 25 }], // future only
    },
  ];

  const tick = await freshTick();
  await tick();

  // Plan had nothing due → schedule drove instead (targetKw 40).
  assert.deepEqual(state.calls, [{ meterId: 1, key: "dischargePowerKw", value: 40, userId: null }]);
});

test("schedules: idempotency suppresses an identical resend within 5 min", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsSchedules, [allDaySchedule()]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);

  const tick = await freshTick();
  await tick();
  await tick();

  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], { meterId: 1, key: "dischargePowerKw", value: 40, userId: null });
});

test("schedules: SOC guard blocks discharge at/below targetSoc and leaves the setpoint untouched", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsSchedules, [allDaySchedule({ targetSoc: 20 })]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);
  state.telemetry.set(1, { socPercent: 10 }); // at/below target → guard active

  const tick = await freshTick();
  await tick();
  assert.equal(state.calls.length, 0);

  state.telemetry.set(1, { socPercent: 55 }); // guard clears
  await tick();
  assert.deepEqual(state.calls, [{ meterId: 1, key: "dischargePowerKw", value: 40, userId: null }]);
});

test("peak shaving: hysteresis + min-move — re-trim only on ≥10% moves, stop below threshold − hysteresis", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsPeakShaving, [peakConfig()]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);

  const tick = await freshTick();
  const setImport = (kw: number) => state.telemetry.set(2, { activePowerKw: kw });

  setImport(130);
  await tick(); // starts: min(30, 50, 100) = 30
  assert.deepEqual(state.calls.map((c) => c.value), [30]);

  setImport(134);
  await tick(); // 34 vs 30: delta 4 < min-move 5 → silent
  assert.deepEqual(state.calls.map((c) => c.value), [30]);

  setImport(136);
  await tick(); // 36 vs 30: delta 6 ≥ 5 → re-trim
  assert.deepEqual(state.calls.map((c) => c.value), [30, 36]);

  setImport(95);
  await tick(); // 95 ≥ 100 − 10 → still riding; hold power 0 is a ≥ min-move change → sent
  assert.deepEqual(state.calls.map((c) => c.value), [30, 36, 0]);

  setImport(85);
  await tick(); // 85 < 100 − 10 → stop (setpoint 0); identical resend suppressed by idempotency
  assert.deepEqual(state.calls.map((c) => c.value), [30, 36, 0]);

  setImport(160);
  await tick(); // new event after the stop: min(60, 50, 100) = 50 (maxDischargeKw cap)
  assert.deepEqual(state.calls.map((c) => c.value), [30, 36, 0, 50]);
});

// ─── audit wave 6: fail-closed SoC guard + plan SoC limits ───────────────────
test("schedules: targetSoc + STALE telemetry → fail-closed block (no setpoint sent)", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsSchedules, [allDaySchedule({ targetSoc: 20 })]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);
  state.telemetry.set(1, { socPercent: 55 }); // SoC itself would allow discharge…
  state.telemetryTs.set(1, new Date(Date.now() - 10 * 60_000)); // …but the row is 10 min old (> 2 min bound)

  const tick = await freshTick();
  await tick();
  assert.equal(state.calls.length, 0); // existing schedule-block behavior: setpoint untouched

  state.telemetryTs.set(1, new Date()); // feed recovers → schedule runs again
  await tick();
  assert.deepEqual(state.calls, [{ meterId: 1, key: "dischargePowerKw", value: 40, userId: null }]);
});

test("schedules: targetSoc + NO telemetry at all → fail-closed block", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsSchedules, [allDaySchedule({ targetSoc: 20 })]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);
  // no telemetry row for meter 1 at all

  const tick = await freshTick();
  await tick();
  assert.equal(state.calls.length, 0);
});

test("plans: minSoc + soc below min → blocked plan setpoint is replaced by idle 0 kW with the reason", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsSchedules, [allDaySchedule()]); // must stand down — the plan owns the tick
  state.whitelists.set("BESS-A", WL_BIPOLAR);
  state.telemetry.set(1, { socPercent: 15 });
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: [{ ts: new Date(Date.now() - 3600_000).toISOString(), kw: 25 }], // discharge 25 kW
      minSoc: 20,
      maxSoc: null,
    },
  ];

  const tick = await freshTick();
  await tick();

  // Deliberate strengthening: explicit idle 0 kW instead of the plan's 25 kW.
  assert.deepEqual(state.calls, [{ meterId: 1, key: "chargeDischargePowerKw", value: 0, userId: null }]);
  // Audit attribution is kept on the blocked command too.
  const tag = state.executedSql.find((q) => /update commands/i.test(q));
  assert.ok(tag, "blocked plan command result must still be tagged");
  assert.match(tag, /plan:volttrade/);

  // Guard clears when SoC recovers above the minimum.
  state.telemetry.set(1, { socPercent: 50 });
  await tick();
  assert.deepEqual(state.calls[1], { meterId: 1, key: "chargeDischargePowerKw", value: 25, userId: null });
});

test("plans: maxSoc + stale SoC → fail-closed block of a plan CHARGE (idle 0 kW)", async () => {
  const { schema } = await setup();
  state.whitelists.set("BESS-A", WL_BIPOLAR);
  state.telemetry.set(1, { socPercent: 50 });
  state.telemetryTs.set(1, new Date(Date.now() - 10 * 60_000)); // stale
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: [{ ts: new Date(Date.now() - 3600_000).toISOString(), kw: -20 }], // charge 20 kW
      minSoc: null,
      maxSoc: 90,
    },
  ];

  const tick = await freshTick();
  await tick();
  assert.deepEqual(state.calls, [{ meterId: 1, key: "chargeDischargePowerKw", value: 0, userId: null }]);
});

test("plans: charge with soc below maxSoc is allowed (guard passes inside the band)", async () => {
  const { schema } = await setup();
  state.whitelists.set("BESS-A", WL_BIPOLAR);
  state.telemetry.set(1, { socPercent: 50 });
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: [{ ts: new Date(Date.now() - 3600_000).toISOString(), kw: -20 }],
      minSoc: 20,
      maxSoc: 90,
    },
  ];

  const tick = await freshTick();
  await tick();
  assert.deepEqual(state.calls, [{ meterId: 1, key: "chargeDischargePowerKw", value: -20, userId: null }]);
});

test("plans without SoC limits are unchanged (regression) — even with NO telemetry", async () => {
  const { schema } = await setup();
  state.whitelists.set("BESS-A", WL_BIPOLAR);
  // no telemetry for meter 1 at all — a plan without limits must NOT fail closed
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: [{ ts: new Date(Date.now() - 3600_000).toISOString(), kw: -20 }],
    },
  ];

  const tick = await freshTick();
  await tick();
  assert.deepEqual(state.calls, [{ meterId: 1, key: "chargeDischargePowerKw", value: -20, userId: null }]);
});

test("peak shaving: active plan minSoc on the same BESS blocks the discharge start (conservative override)", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsPeakShaving, [peakConfig()]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);
  state.telemetry.set(2, { activePowerKw: 130 }); // over threshold — would start
  state.telemetry.set(1, { socPercent: 15 }); // …but the BESS is at/below the plan's min
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: [{ ts: new Date(Date.now() + 3600_000).toISOString(), kw: 25 }], // future only — plan sends nothing
      minSoc: 20,
      maxSoc: null,
    },
  ];

  const tick = await freshTick();
  await tick();
  assert.equal(state.calls.length, 0); // peak did not start; plan had nothing due
});

test("peak shaving: a RUNNING event is cut to idle 0 kW when the plan minSoc becomes violated", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsPeakShaving, [peakConfig()]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);
  state.telemetry.set(2, { activePowerKw: 130 });
  state.telemetry.set(1, { socPercent: 50 });
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: [{ ts: new Date(Date.now() + 3600_000).toISOString(), kw: 25 }], // future only
      minSoc: 20,
      maxSoc: null,
    },
  ];

  const tick = await freshTick();
  await tick(); // starts: min(30, 50, 100) = 30 — SoC 50 > min 20, allowed
  assert.deepEqual(state.calls.map((c) => c.value), [30]);

  state.telemetry.set(1, { socPercent: 18 }); // SoC dropped below the plan minimum
  await tick(); // blocked → active event cut to idle 0 kW
  assert.deepEqual(state.calls.map((c) => c.value), [30, 0]);
});

test("peak shaving: unknown/stale BESS SoC fails closed under the plan-limits override", async () => {
  const { schema, tables } = await setup();
  tables.set(schema.emsPeakShaving, [peakConfig()]);
  state.whitelists.set("BESS-A", WL_DISCHARGE);
  state.telemetry.set(2, { activePowerKw: 130 });
  // NO BESS telemetry at all → soc unknown → blocked (fail-closed)
  state.planRows = [
    {
      id: 9,
      meterId: 1,
      source: "volttrade",
      setpoints: [{ ts: new Date(Date.now() + 3600_000).toISOString(), kw: 25 }],
      minSoc: 20,
      maxSoc: null,
    },
  ];

  const tick = await freshTick();
  await tick();
  assert.equal(state.calls.length, 0);
});

test("robustness: the tick never throws, even when the DB is down", async () => {
  state.db = {
    select: () => {
      throw new Error("db down");
    },
    execute: async () => {
      throw new Error("db down");
    },
  };
  const tick = await freshTick();
  await tick(); // must resolve
  assert.equal(state.calls.length, 0);
});
