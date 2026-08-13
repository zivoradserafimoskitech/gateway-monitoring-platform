// Tests for the C12 active-control interlock (v10/P1-9): the whitelist +
// range + transport validation in executeControl, and the executeAndLog audit
// trail. The DB and the MQTT downlink are mocked — no bus traffic, no DB.
// The interlock code itself is NOT modified by this change set.
import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { crc16 } from "../modbus";
import { deviceProfiles, gateways } from "@db/schema";

const state = vi.hoisted(() => ({
  db: null as unknown,
  profiles: [] as Array<{ model: string; controllable: unknown }>,
  gateways: [] as Array<{ id: number; transport: string; uid: string; model: string }>,
  inserted: [] as Array<Record<string, unknown>>,
  sentFrames: [] as Array<{ gatewayUid: string; frame: Buffer }>,
}));

vi.mock("../queries/connection", () => ({ getDb: () => state.db }));

vi.mock("../mqtt/service", () => ({
  sendControlFrame: async (gateway: { uid: string }, frame: Buffer) => {
    state.sentFrames.push({ gatewayUid: gateway.uid, frame });
    return { topic: "mock", hex: frame.toString("hex") };
  },
}));

import { ControlError, executeAndLog, executeControl } from "./execute";

/** Fake drizzle client: select resolves per-table rows; insert records values. */
function fakeDb(): void {
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
    select: () => ({
      from: (table: unknown) => {
        const rows = table === deviceProfiles ? state.profiles : table === gateways ? state.gateways : [];
        return makeQuery(rows);
      },
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        state.inserted.push(v);
        return [];
      },
    }),
  };
}

const meter = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    gatewayId: 7,
    name: "bess-1",
    model: "BESS-A",
    host: null, // bus device — never opens a TCP socket
    port: null,
    unitId: 5,
    modbusAddress: 5,
    ...over,
  }) as never;

const TRANSPARENT_GW = { id: 7, transport: "transparent", uid: "gw-1", model: "C30" };
const WL = { dischargePowerKw: { address: 10, min: 0, max: 100 } };

beforeEach(() => {
  state.profiles = [{ model: "BESS-A", controllable: WL }];
  state.gateways = [TRANSPARENT_GW];
  state.inserted = [];
  state.sentFrames = [];
  fakeDb();
});

// ─── Whitelist interlock ─────────────────────────────────────────────────────
test("interlock: a non-whitelisted key is rejected before any bus traffic", async () => {
  await assert.rejects(executeControl(meter(), "gridVoltage", 10), ControlError);
  await assert.rejects(
    executeControl(meter(), "gridVoltage", 10),
    (e: Error) => e.message.includes("'gridVoltage' is not controllable on model BESS-A") && e.message.includes("dischargePowerKw"),
  );
  assert.equal(state.sentFrames.length, 0);
});

test("interlock: a model with no writable registers says so explicitly", async () => {
  state.profiles = [{ model: "BESS-A", controllable: null }];
  await assert.rejects(executeControl(meter(), "anything", 1), (e: Error) => e.message.includes("model has no writable registers"));
});

// ─── Range interlock ─────────────────────────────────────────────────────────
test("interlock: out-of-range values are rejected with the declared bounds", async () => {
  await assert.rejects(executeControl(meter(), "dischargePowerKw", 150), (e: Error) =>
    e.message.includes("value 150 out of range for 'dischargePowerKw' [0..100]"),
  );
  await assert.rejects(executeControl(meter(), "dischargePowerKw", -1), ControlError);
  await assert.rejects(executeControl(meter(), "dischargePowerKw", NaN), ControlError);
  assert.equal(state.sentFrames.length, 0);
});

test("interlock: boundary values are in range", async () => {
  const r = await executeControl(meter(), "dischargePowerKw", 100); // == max
  assert.equal(r.status, "sent");
  const r0 = await executeControl(meter(), "dischargePowerKw", 0); // == min
  assert.equal(r0.status, "sent");
});

test("interlock: FC16 registers are refused (FC6 only)", async () => {
  state.profiles = [{ model: "BESS-A", controllable: { x: { address: 1, min: 0, max: 10, fc: 16 } } }];
  await assert.rejects(executeControl(meter(), "x", 5), (e: Error) => e.message.includes("FC6 only"));
});

test("interlock: scaled values must fit a 16-bit register", async () => {
  state.profiles = [{ model: "BESS-A", controllable: { x: { address: 1, min: 0, max: 100_000, scale: 10 } } }];
  await assert.rejects(executeControl(meter(), "x", 100_000), (e: Error) => e.message.includes("does not fit a 16-bit register"));
});

// ─── Transport interlock ─────────────────────────────────────────────────────
test("interlock: devices behind a non-transparent gateway have no downlink channel", async () => {
  state.gateways = [{ id: 7, transport: "json", uid: "gw-g30", model: "G30" }];
  const r = await executeControl(meter(), "dischargePowerKw", 40);
  assert.equal(r.status, "failed");
  assert.match(r.detail, /no downlink control channel/);
  assert.equal(state.sentFrames.length, 0);
});

test("transparent gateway: an FC6 frame is published to the downlink topic", async () => {
  const r = await executeControl(meter(), "dischargePowerKw", 40);
  assert.equal(r.status, "sent");
  assert.equal(state.sentFrames.length, 1);
  const { frame, gatewayUid } = state.sentFrames[0];
  assert.equal(gatewayUid, "gw-1");
  // FC6 frame: slave, fc=6, address BE, value BE, crc16 LE.
  assert.equal(frame.length, 8);
  assert.equal(frame[0], 5); // unitId
  assert.equal(frame[1], 6);
  assert.equal(frame.readUInt16BE(2), 10); // register address
  assert.equal(frame.readUInt16BE(4), 40); // setpoint (scale 1)
  assert.equal(frame.readUInt16LE(6), crc16(frame.subarray(0, 6)));
});

test("interlock: bus address outside 1..255 is refused", async () => {
  const r = await executeControl(meter({ unitId: 0, modbusAddress: 0 }), "dischargePowerKw", 40);
  assert.equal(r.status, "failed");
  assert.match(r.detail, /out of Modbus range/);
});

// ─── executeAndLog audit trail ───────────────────────────────────────────────
test("executeAndLog: a successful write is audited with userId and result", async () => {
  const r = await executeAndLog(meter(), "dischargePowerKw", 40, 42);
  assert.equal(r.status, "sent");
  assert.equal(state.inserted.length, 1);
  const row = state.inserted[0];
  assert.equal(row.meterId, 1);
  assert.equal(row.userId, 42);
  assert.equal(row.controlKey, "dischargePowerKw");
  assert.equal(row.controlValue, 40);
  assert.equal(row.status, "sent");
});

test("executeAndLog: a rejected setpoint is still audited (status failed, 'rejected: …') and rethrows", async () => {
  await assert.rejects(executeAndLog(meter(), "notAKey", 1, null), ControlError);
  assert.equal(state.inserted.length, 1);
  const row = state.inserted[0];
  assert.equal(row.status, "failed");
  assert.match(String(row.result), /^rejected: /);
  assert.equal(row.userId, null); // system commands (EMS controller) log null userId
});
