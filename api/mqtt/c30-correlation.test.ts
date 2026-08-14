// Wave 4 / C30 T1 tests: response/base-address correlation on the transparent
// channel. DB, telemetry writer and MQTT publish are mocked — no broker, no DB.
import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { crc16 } from "../modbus";
import { alarmRules, deviceProfiles, meters as metersTable } from "@db/schema";
import type { RegisterDef } from "@contracts/modbus";

const state = vi.hoisted(() => ({
  db: null as unknown,
  profiles: [] as Array<{ model: string; registerMap: RegisterDef[]; deviceType: string; brand: string | null }>,
  meterRows: [] as Array<Record<string, unknown>>,
  telemetry: [] as Array<{ meterId: number; values: Record<string, number> }>,
  commandsInserted: [] as Array<Record<string, unknown>>,
  commandsUpdated: [] as Array<Record<string, unknown>>,
  published: [] as Array<{ topic: string; frame: Buffer }>,
  nextCommandId: 1,
}));

vi.mock("../queries/connection", () => ({ getDb: () => state.db }));

vi.mock("../telemetry", () => ({
  getTelemetryWriter: () => ({
    push: (row: { meterId: number; values: Record<string, number> }) => state.telemetry.push(row),
  }),
  getTelemetryStats: () => ({}),
}));

vi.mock("../alarms/notify", () => ({
  isInMaintenance: async () => false,
  notifyAlarmBreach: async () => undefined,
}));

import { handleC30Frame, meterCache, invalidateProfileCache } from "./handlers";
import { sendReadNow } from "./service";
import {
  registerOutstanding,
  clearOutstanding,
  outstandingSize,
  sweepOutstanding,
} from "./c30-outstanding";
import { getC30UndecodableCounts } from "../lib/observability";

/** Fake drizzle client covering the chains these paths use. */
function fakeDb(): void {
  const thenable = (rows: unknown[]): unknown => ({
    where: () => thenable(rows),
    orderBy: () => thenable(rows),
    limit: () => thenable(rows),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(rows).then(onF, onR),
  });
  state.db = {
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === deviceProfiles
            ? state.profiles
            : table === metersTable
              ? state.meterRows
              : table === alarmRules
                ? []
                : [];
        return thenable(rows);
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.commandsInserted.push(v);
        return { $returningId: async () => [{ id: state.nextCommandId++ }] };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          state.commandsUpdated.push(v);
        },
      }),
    }),
  };
}

function buildResponse(slave: number, fc: number, data: Buffer): Buffer {
  const body = Buffer.alloc(3 + data.length);
  body.writeUInt8(slave, 0);
  body.writeUInt8(fc, 1);
  body.writeUInt8(data.length, 2);
  data.copy(body, 3);
  const crc = crc16(body);
  const tail = Buffer.alloc(2);
  tail.writeUInt16LE(crc, 0);
  return Buffer.concat([body, tail]);
}

const gateway = {
  id: 42,
  uid: "c30-test",
  name: "C30 test",
  model: "C30",
  transport: "transparent",
  topicPrefix: "d2g",
  status: "online",
  lastSeenAt: new Date(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const f32 = (key: string, address: number, fc: 3 | 4 = 3): RegisterDef => ({
  key,
  label: key,
  address,
  functionCode: fc,
  type: "float32",
  scale: 1,
  unit: "",
});

function seedMeterAndProfile(map: RegisterDef[], model = "TESTMETER"): void {
  state.profiles = [{ model, registerMap: map, deviceType: "meter", brand: "Test" }];
  const meter = {
    id: 7,
    gatewayId: gateway.id,
    name: "test meter",
    model,
    deviceType: "meter",
    brand: "Test",
    phases: "three",
    modbusAddress: 1,
    unitId: null,
    status: "online",
    lastSeenAt: new Date(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  meterCache.set(`${gateway.id}:1`, { at: Date.now(), meter });
  state.meterRows = [meter];
}

beforeEach(() => {
  fakeDb();
  clearOutstanding();
  meterCache.clear();
  invalidateProfileCache();
  state.telemetry = [];
  state.commandsInserted = [];
  state.commandsUpdated = [];
  state.published = [];
  state.nextCommandId = 1;
});

test("does not decode a frame whose byte count matches no block", async () => {
  // 20-byte payload from slave 1, profile has no 10-register block
  // (map: 3 float32 @0,2,4 → a single 12-byte block).
  seedMeterAndProfile([f32("voltageL1", 0), f32("voltageL2", 2), f32("voltageL3", 4)]);
  const before = getC30UndecodableCounts().no_match ?? 0;
  const frame = buildResponse(1, 3, Buffer.alloc(20));
  const res = await handleC30Frame(gateway, frame);
  assert.equal(res.decoded, false);
  assert.equal(state.telemetry.length, 0); // nothing persisted — drop over guess
  assert.equal((getC30UndecodableCounts().no_match ?? 0) - before, 1);
});

test("decodes a solicited response against the REQUESTED base, not the span", async () => {
  // Request registers 100..109, profile span starts at 0.
  // Old code decoded at 0 and produced wrong values.
  seedMeterAndProfile([f32("voltageL1", 0), f32("voltageL2", 2), f32("voltageL3", 4)]);
  registerOutstanding({ gatewayId: gateway.id, slave: 1, fc: 3, start: 100, quantity: 10 });
  const res = await handleC30Frame(gateway, buildResponse(1, 3, Buffer.alloc(20)));
  assert.equal(res.decoded, true);
  assert.equal(res.baseAddress, 100);
  // The outstanding entry is consumed by the match.
  assert.equal(outstandingSize(), 0);
});

test("unsolicited frame is accepted only when exactly one block matches", async () => {
  const map = [f32("voltageL1", 0), f32("voltageL2", 2), f32("voltageL3", 4), { ...f32("statusCode", 100), type: "u16" as const }];
  seedMeterAndProfile(map);
  const payload = Buffer.alloc(12);
  payload.writeFloatBE(231.5, 0);
  payload.writeFloatBE(230.1, 4);
  payload.writeFloatBE(229.9, 8);
  const res = await handleC30Frame(gateway, buildResponse(1, 3, payload));
  assert.equal(res.decoded, true);
  assert.equal(res.baseAddress, 0);
  assert.equal(state.telemetry.length, 1);
  assert.ok(Math.abs(state.telemetry[0].values.voltageL1 - 231.5) < 1e-6);
});

test("ambiguous frame (two blocks with the same byte count) is discarded", async () => {
  // Two 2-byte blocks: u16 @0 and u16 @50 (gap > 8 words).
  seedMeterAndProfile([
    { ...f32("statusCode", 0), type: "u16" as const },
    { ...f32("faultCode", 50), type: "u16" as const },
  ]);
  const before = getC30UndecodableCounts().ambiguous ?? 0;
  const res = await handleC30Frame(gateway, buildResponse(1, 3, Buffer.alloc(2)));
  assert.equal(res.decoded, false);
  assert.equal(state.telemetry.length, 0);
  assert.equal((getC30UndecodableCounts().ambiguous ?? 0) - before, 1);
});

test("wide profile (>125-register span) frame that matches no block counts span_too_wide", async () => {
  // span = 202 words > 125 → registerSpan null; blocks are 4 bytes each.
  seedMeterAndProfile([f32("voltageL1", 0), f32("energyTotalKwh", 200)]);
  const before = getC30UndecodableCounts().span_too_wide ?? 0;
  const res = await handleC30Frame(gateway, buildResponse(1, 3, Buffer.alloc(20)));
  assert.equal(res.decoded, false);
  assert.equal((getC30UndecodableCounts().span_too_wide ?? 0) - before, 1);
});

test("sendReadNow issues one correlated request per block", async () => {
  // Two 4-word blocks: float32 @0,2 and float32 @50,52 (gap 46 > 8 words).
  seedMeterAndProfile([f32("voltageL1", 0), f32("voltageL2", 2), f32("energyA", 50), f32("energyB", 52)]);
  globalThis.__enertrekMqtt = {
    client: {
      connected: true,
      publish: (topic: string, frame: Buffer, _opts: unknown, cb: (err?: Error) => void) => {
        state.published.push({ topic, frame });
        cb();
      },
    },
    brokerPort: null,
    startedAt: new Date(),
    messagesIn: 0,
    lastError: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  try {
    const res = await sendReadNow(gateway, 7);
    assert.equal(res.topic, "g2d/c30-test");
    // 2 blocks → 2 published frames, 2 commands rows, 2 outstanding entries.
    assert.equal(state.published.length, 2);
    assert.equal(state.commandsInserted.length, 2);
    assert.deepEqual(
      state.commandsInserted.map((c) => [c.reqSlave, c.reqFc, c.reqStart, c.reqQuantity]),
      [
        [1, 3, 0, 4],
        [1, 3, 50, 4],
      ],
    );
    assert.ok(state.commandsInserted.every((c) => c.kind === "readNow" && c.status === "sent"));
    assert.equal(outstandingSize(), 2);
  } finally {
    globalThis.__enertrekMqtt = undefined;
  }
});

// ─── Wave 4 / T4: C30 control-write read-back confirmation ──────────────────

test("write-confirm: correlated read-back marks the control row ok", async () => {
  seedMeterAndProfile([f32("voltageL1", 0)]);
  registerOutstanding({
    gatewayId: gateway.id,
    slave: 1,
    fc: 3,
    start: 300,
    quantity: 1,
    verifyExpected: 500,
    verifyCommandId: 99,
  });
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(500, 0);
  const res = await handleC30Frame(gateway, buildResponse(1, 3, payload));
  assert.equal(res.decoded, true);
  assert.equal(res.baseAddress, 300);
  const upd = state.commandsUpdated.at(-1);
  assert.equal(upd?.status, "ok");
  assert.match(String(upd?.result), /read-back verified: register 300 = 500/);
  assert.equal(outstandingSize(), 0);
});

test("write-confirm: read-back mismatch marks the control row failed", async () => {
  seedMeterAndProfile([f32("voltageL1", 0)]);
  registerOutstanding({
    gatewayId: gateway.id,
    slave: 1,
    fc: 3,
    start: 300,
    quantity: 1,
    verifyExpected: 500,
    verifyCommandId: 100,
  });
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(400, 0); // register reads back something else
  const res = await handleC30Frame(gateway, buildResponse(1, 3, payload));
  assert.equal(res.decoded, true);
  const upd = state.commandsUpdated.at(-1);
  assert.equal(upd?.status, "failed");
  assert.match(String(upd?.result), /mismatch: register 300 reads 400, expected 500/);
});

test("write-confirm: sweep fails rows with no read-back within 30s", async () => {
  registerOutstanding({
    gatewayId: gateway.id,
    slave: 1,
    fc: 3,
    start: 300,
    quantity: 1,
    verifyExpected: 500,
    verifyCommandId: 101,
    deadline: Date.now() - 1, // already past the 30s deadline
  });
  const expired = await sweepOutstanding();
  assert.equal(expired, 1);
  const upd = state.commandsUpdated.at(-1);
  assert.equal(upd?.status, "failed");
  assert.equal(upd?.result, "no read-back within 30s");
  assert.equal(outstandingSize(), 0);
});
