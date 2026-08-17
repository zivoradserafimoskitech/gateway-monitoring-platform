// audit wave 6: TelemetryStore.freshForControl — the age-bounded read used by
// EMS control decisions only. latest() stays unbounded (dashboards/reads).
// Everything external (metadata DB pool) is mocked — no real database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: null as unknown,
  latestRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../queries/connection", () => ({
  getDb: () => state.db,
  createWriteDb: () => state.db,
}));

import { MySqlTelemetryStore } from "./mysql-store";
import { TimescaleTelemetryStore } from "./timescale-store";

/** select() chain resolving to state.latestRows (mirrors drizzle's chaining). */
function fakeSelectDb(): unknown {
  const q = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(state.latestRows).then(onF, onR),
  };
  return { select: () => ({ from: () => q }) };
}

const NULL_COLS = {
  voltageL1: null, voltageL2: null, voltageL3: null,
  currentL1: null, currentL2: null, currentL3: null,
  activePowerKw: null, reactivePowerKvar: null, apparentPowerKva: null,
  powerFactor: null, frequencyHz: null,
  energyImportKwh: null, energyExportKwh: null, demandKw: null,
};

function mysqlRow(ts: Date): Record<string, unknown> {
  return { id: 1, meterId: 1, ts, ...NULL_COLS, valuesJson: { socPercent: 55 }, raw: null };
}

beforeEach(() => {
  state.db = fakeSelectDb();
  state.latestRows = [];
});

describe("MySqlTelemetryStore.freshForControl", () => {
  it("fresh row → fresh=true with ageMs and the row (values merged as in latest())", async () => {
    state.latestRows = [mysqlRow(new Date(Date.now() - 5_000))];
    const store = new MySqlTelemetryStore();
    const r = await store.freshForControl(1);
    expect(r.fresh).toBe(true);
    expect(r.row?.values.socPercent).toBe(55);
    expect(r.ageMs).not.toBeNull();
    expect(r.ageMs!).toBeGreaterThanOrEqual(5_000);
    expect(r.ageMs!).toBeLessThan(120_000);
  });

  it("stale row (ts = now−10min, default maxAge 2min) → fresh=false but the row is STILL returned", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    state.latestRows = [mysqlRow(tenMinAgo)];
    const store = new MySqlTelemetryStore();
    const r = await store.freshForControl(1);
    expect(r.fresh).toBe(false);
    expect(r.row).not.toBeNull(); // stale row is still returned — the caller decides
    expect(r.row!.ts.getTime()).toBe(tenMinAgo.getTime());
    expect(r.ageMs!).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("explicit maxAgeMs overrides the boot-time default in both directions", async () => {
    state.latestRows = [mysqlRow(new Date(Date.now() - 5_000))];
    const store = new MySqlTelemetryStore();
    expect((await store.freshForControl(1, 1_000)).fresh).toBe(false); // 1s bound → stale
    expect((await store.freshForControl(1, 60_000)).fresh).toBe(true); // 1min bound → fresh
  });

  it("no row → row=null, fresh=false, ageMs=null", async () => {
    state.latestRows = [];
    const store = new MySqlTelemetryStore();
    expect(await store.freshForControl(1)).toEqual({ row: null, fresh: false, ageMs: null });
  });
});

describe("TimescaleTelemetryStore.freshForControl (contract parity)", () => {
  function tsStore(rows: Array<Record<string, unknown>>): TimescaleTelemetryStore {
    const store = new TimescaleTelemetryStore("postgres://unused:5432/unused");
    // Swap the pool before any connection is opened — latest() is one query.
    (store as unknown as { pool: unknown }).pool = { query: async () => ({ rows }) };
    return store;
  }

  const tsRow = (ts: Date) => ({
    ts, meter_id: 1,
    voltage_l1: null, voltage_l2: null, voltage_l3: null,
    current_l1: null, current_l2: null, current_l3: null,
    active_power_kw: null, reactive_power_kvar: null, apparent_power_kva: null,
    power_factor: null, frequency_hz: null,
    energy_import_kwh: null, energy_export_kwh: null, demand_kw: null,
    raw: null, values_json: { socPercent: 55 },
  });

  it("fresh / stale / no-row semantics match the MySQL store", async () => {
    const fresh = await tsStore([tsRow(new Date())]).freshForControl(1);
    expect(fresh.fresh).toBe(true);
    expect(fresh.row?.values.socPercent).toBe(55);

    const stale = await tsStore([tsRow(new Date(Date.now() - 10 * 60_000))]).freshForControl(1);
    expect(stale.fresh).toBe(false);
    expect(stale.row).not.toBeNull();
    expect(stale.ageMs!).toBeGreaterThanOrEqual(10 * 60_000);

    expect(await tsStore([]).freshForControl(1)).toEqual({ row: null, fresh: false, ageMs: null });
  });
});
