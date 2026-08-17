// Wave 5 / T3: endpoint tests for the bench-verification workflow —
// profiles.verifyRead / verifySign / verifyControlRoundTrip /
// completeBenchVerification. DB is faked (drizzle-shaped), the live Modbus
// read and the MQTT downlink are mocked — no device, no DB, no bus traffic.
// Pins: read flags (out_of_range, implausible_soc, implausible_voltage,
// beyond_nameplate), sign recording, the round-trip RESPECTING the T1 draft
// gate (blocked without override; proceeds with WARNING under it), admin-only
// completion, dischargePositive required for power-setpoint profiles,
// override cleared + verifiedBy/At set on completion.
import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { TRPCError } from "@trpc/server";
import { deviceProfiles, gateways, meters } from "@db/schema";
import { UNVERIFIED_OVERRIDE_WARNING } from "../control/execute";

const state = vi.hoisted(() => ({
  db: null as unknown,
  profiles: [] as Array<Record<string, unknown>>,
  meters: [] as Array<Record<string, unknown>>,
  gateways: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  commands: [] as Array<Record<string, unknown>>,
  live: {
    ok: true,
    error: undefined as string | undefined,
    values: {} as Record<string, { key: string; raw?: number; value?: number; error?: string }>,
  },
}));

vi.mock("../queries/connection", () => ({ getDb: () => state.db }));
vi.mock("../mqtt/handlers", () => ({ invalidateProfileCache: () => undefined }));
vi.mock("../mqtt/service", () => ({
  sendControlFrame: async (_gw: { uid: string }, frame: Buffer) => ({ topic: "mock", hex: frame.toString("hex") }),
}));
vi.mock("../profile-import/preview", () => ({
  readDeviceRegisters: async () => state.live,
}));
// Deterministic TCP control path: the mocked client accepts the write and
// reads back exactly the written register value.
vi.mock("modbus-serial", () => ({
  default: class {
    private lastWritten: number | undefined;
    setTimeout() {}
    setID() {}
    async connectTCP() {}
    async writeRegister(_addr: number, value: number) {
      this.lastWritten = value;
    }
    async readHoldingRegisters() {
      return { data: [this.lastWritten], buffer: Buffer.alloc(2) };
    }
    close(cb: () => void) {
      cb();
    }
  },
}));

import { profilesRouter } from "./profiles";

/** Command-log rows only — the RBAC middleware's fire-and-forget audit
 *  insert shares the fake insert() and must not pollute command assertions. */
const commandRows = () => state.commands.filter((c) => c.controlKey !== undefined);

/** Fake drizzle client: select per-table rows; update/insert record calls. */
function fakeDb(): void {
  const makeQuery = (rows: unknown[]): unknown => ({
    where: () => makeQuery(rows),
    orderBy: () => makeQuery(rows),
    limit: () => makeQuery(rows),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(rows).then(onF, onR),
  });
  state.db = {
    select: () => ({
      from: (table: unknown) =>
        makeQuery(
          table === deviceProfiles ? state.profiles : table === meters ? state.meters : table === gateways ? state.gateways : [],
        ),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        state.updates.push(v);
        return { where: () => Promise.resolve([{ affectedRows: 1 }]) };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.commands.push(v);
        const id = state.commands.length;
        return {
          $returningId: async () => [{ id }],
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve([{ id }]).then(onF, onR),
          catch: () => undefined, // RBAC fire-and-forget audit insert
        };
      },
    }),
  };
}

const REGISTER_MAP = [
  { key: "socPercent", label: "Battery SOC", address: 13022, functionCode: 3, type: "u16", scale: 0.1, unit: "%", min: 0, max: 100 },
  { key: "dcVoltage", label: "DC voltage", address: 13023, functionCode: 3, type: "u16", scale: 0.1, unit: "V" },
  { key: "batteryPowerKw", label: "Battery power", address: 13021, functionCode: 3, type: "i16", scale: 0.1, unit: "kW" },
];
const CONTROLLABLE = { activePowerSetpointKw: { address: 13051, min: -100, max: 100, scale: 10, unit: "kW" } };

function profileRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    model: "vendor-x-bess-100",
    label: "Vendor X BESS 100kW",
    verificationStatus: "draft",
    allowUnverifiedControl: false,
    dischargePositive: null,
    registerMap: REGISTER_MAP,
    controllable: CONTROLLABLE,
    ...over,
  };
}

const BUS_METER = { id: 5, orgId: 1, host: null, port: null, unitId: 1, modbusAddress: 1, model: "vendor-x-bess-100", gatewayId: 7 };
const GW = { id: 7, transport: "transparent", uid: "gw-01", model: "C30" };

function caller(role: "admin" | "operator" | "viewer" | null) {
  const ctx = {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    sessionToken: null,
    user:
      role === null
        ? null
        : ({ id: 9, email: `${role}@example.test`, role, orgId: 1, isSuperadmin: false } as never),
  };
  return profilesRouter.createCaller(ctx);
}

beforeEach(() => {
  process.env.AUTH_REQUIRED = "true";
  state.profiles = [profileRow()];
  state.meters = [{ ...BUS_METER }];
  state.gateways = [{ ...GW }];
  state.updates = [];
  state.commands = [];
  state.live = { ok: true, error: undefined, values: {} };
  fakeDb();
});

// ─── verifyRead ─────────────────────────────────────────────────────────────

test("verifyRead: per-key values with out_of_range + implausible_soc flags", async () => {
  state.live.values = {
    socPercent: { key: "socPercent", raw: 65535, value: 6553.5 }, // wrong scale smell
    dcVoltage: { key: "dcVoltage", raw: 8000, value: 800 },
    batteryPowerKw: { key: "batteryPowerKw", raw: 120, value: 12 },
  };
  const res = await caller("operator").verifyRead({ profileId: 1, deviceId: 5 });
  assert.equal(res.ok, true);
  const soc = res.rows.find((r) => r.key === "socPercent")!;
  assert.equal(soc.raw, 65535);
  assert.equal(soc.value, 6553.5);
  assert.equal(soc.inRange, false);
  assert.ok(soc.flags.includes("out_of_range"));
  assert.ok(soc.flags.includes("implausible_soc"));
  const volt = res.rows.find((r) => r.key === "dcVoltage")!;
  assert.equal(volt.inRange, null); // no declared bounds → not judged
  assert.deepEqual(volt.flags, []);
  const pwr = res.rows.find((r) => r.key === "batteryPowerKw")!;
  assert.deepEqual(pwr.flags, []);
  assert.equal(res.nameplateAbsMax, 100); // from the controllable setpoint
});

test("verifyRead: implausible_voltage and beyond_nameplate heuristics", async () => {
  state.live.values = {
    socPercent: { key: "socPercent", raw: 550, value: 55 },
    dcVoltage: { key: "dcVoltage", raw: 65530, value: 6553 }, // scaling error
    batteryPowerKw: { key: "batteryPowerKw", raw: 1500, value: 150 }, // > 100 kW nameplate
  };
  const res = await caller("operator").verifyRead({ profileId: 1, deviceId: 5 });
  assert.ok(res.rows.find((r) => r.key === "dcVoltage")!.flags.includes("implausible_voltage"));
  assert.ok(res.rows.find((r) => r.key === "batteryPowerKw")!.flags.includes("beyond_nameplate"));
});

test("verifyRead: device/profile model mismatch and viewer RBAC rejected", async () => {
  state.meters = [{ ...BUS_METER, model: "other-model" }];
  await assert.rejects(
    caller("operator").verifyRead({ profileId: 1, deviceId: 5 }),
    (e: Error) => e instanceof TRPCError && e.code === "BAD_REQUEST" && /does not match/.test(e.message),
  );
  await assert.rejects(
    caller("viewer").verifyRead({ profileId: 1, deviceId: 5 }),
    (e: Error) => e instanceof TRPCError && e.code === "FORBIDDEN",
  );
});

// ─── verifySign ─────────────────────────────────────────────────────────────

test("verifySign: records the operator's sign-convention answer on the profile", async () => {
  await caller("operator").verifySign({ profileId: 1, deviceId: 5, dischargePositive: true });
  assert.deepEqual(state.updates.at(-1), { dischargePositive: true });
  await caller("operator").verifySign({ profileId: 1, deviceId: 5, dischargePositive: false });
  assert.deepEqual(state.updates.at(-1), { dischargePositive: false });
});

test("verifySign: unknown profile → NOT_FOUND", async () => {
  state.profiles = [];
  await assert.rejects(
    caller("operator").verifySign({ profileId: 99, deviceId: 5, dischargePositive: true }),
    (e: Error) => e instanceof TRPCError && e.code === "NOT_FOUND",
  );
});

// ─── verifyControlRoundTrip ─────────────────────────────────────────────────

test("round-trip: DRAFT profile without override → blocked by the T1 gate (designed behaviour)", async () => {
  await assert.rejects(
    caller("operator").verifyControlRoundTrip({ profileId: 1, deviceId: 5, key: "activePowerSetpointKw", value: 5 }),
    (e: Error) => e instanceof TRPCError && e.code === "BAD_REQUEST" && /unverified/.test(e.message),
  );
  // the rejection itself is audited as a failed command
  assert.equal(commandRows().length, 1);
  assert.match(String(commandRows()[0].result), /rejected:.*unverified/);
});

test("round-trip: DRAFT profile WITH override → proceeds, WARNING marker on result + audit row", async () => {
  state.profiles = [profileRow({ allowUnverifiedControl: true })];
  const res = await caller("operator").verifyControlRoundTrip({
    profileId: 1,
    deviceId: 5,
    key: "activePowerSetpointKw",
    value: 5,
  });
  assert.equal(res.status, "sent"); // C30 bus path: read-back pending
  assert.equal(res.warning, true);
  assert.ok(res.detail.startsWith(UNVERIFIED_OVERRIDE_WARNING));
  assert.equal(res.expectedRaw, 50); // 5 kW × scale 10
  assert.match(res.readBack.error ?? "", /bus device/);
  const logRow = commandRows().find((c) => c.controlKey === "activePowerSetpointKw")!;
  assert.match(String(logRow.result), /^WARNING/);
});

test("round-trip: bench_verified profile → no WARNING; TCP read-back returns raw + scaled side by side", async () => {
  state.profiles = [profileRow({ verificationStatus: "bench_verified" })];
  state.meters = [{ ...BUS_METER, host: "192.0.2.99", port: 502 }]; // mocked modbus-serial client
  state.live.values = { activePowerSetpointKw: { key: "activePowerSetpointKw", raw: 50, value: 5 } };
  const res = await caller("operator").verifyControlRoundTrip({
    profileId: 1,
    deviceId: 5,
    key: "activePowerSetpointKw",
    value: 5,
  });
  assert.equal(res.status, "ok"); // mocked client echoes the write on read-back
  assert.equal(res.warning, false);
  assert.equal(res.expectedRaw, 50);
  assert.equal(res.readBack.raw, 50);
  assert.equal(res.readBack.value, 5); // raw ÷ controllable scale → engineering units
});

test("round-trip: non-writable key rejected before any bus traffic", async () => {
  state.profiles = [profileRow({ allowUnverifiedControl: true })];
  await assert.rejects(
    caller("operator").verifyControlRoundTrip({ profileId: 1, deviceId: 5, key: "socPercent", value: 1 }),
    (e: Error) => e instanceof TRPCError && e.code === "BAD_REQUEST" && /not a writable key/.test(e.message),
  );
  assert.equal(commandRows().length, 0); // rejected before any bus traffic
});

// ─── completeBenchVerification ──────────────────────────────────────────────

const COMPLETE = { profileId: 1, firmwareVersion: "FW 2.3.1", serial: "SN-0042", testedNotes: "read map + 5 kW round-trip" };

test("complete: ADMIN-only — operator and viewer are FORBIDDEN", async () => {
  await assert.rejects(caller("operator").completeBenchVerification(COMPLETE), (e: Error) => (e as TRPCError).code === "FORBIDDEN");
  await assert.rejects(caller("viewer").completeBenchVerification(COMPLETE), (e: Error) => (e as TRPCError).code === "FORBIDDEN");
  assert.equal(state.updates.length, 0);
});

test("complete: power-setpoint profile with dischargePositive NULL → refused", async () => {
  await assert.rejects(
    caller("admin").completeBenchVerification(COMPLETE),
    (e: Error) => e instanceof TRPCError && e.code === "BAD_REQUEST" && /Sign convention not recorded/.test(e.message),
  );
  assert.equal(state.updates.length, 0);
});

test("complete: sets bench_verified + verifiedBy/At + notes, CLEARS the override", async () => {
  state.profiles = [profileRow({ allowUnverifiedControl: true, dischargePositive: false })];
  await caller("admin").completeBenchVerification(COMPLETE);
  const patch = state.updates.at(-1)!;
  assert.equal(patch.verificationStatus, "bench_verified");
  assert.equal(patch.verifiedBy, 9);
  assert.ok(patch.verifiedAt instanceof Date);
  assert.equal(patch.allowUnverifiedControl, false); // cleared per task file
  assert.match(String(patch.verifiedNotes), /Firmware: FW 2\.3\.1/);
  assert.match(String(patch.verifiedNotes), /Serial: SN-0042/);
  assert.match(String(patch.verifiedNotes), /Tested: read map \+ 5 kW round-trip/);
});

test("complete: profile WITHOUT a power setpoint does not require dischargePositive", async () => {
  state.profiles = [profileRow({ controllable: { modeRegister: { address: 13000, min: 0, max: 3 } } })];
  await caller("admin").completeBenchVerification(COMPLETE);
  assert.equal(state.updates.at(-1)!.verificationStatus, "bench_verified");
});

test("revert path intact: admin can still revert bench_verified → draft (clears verifiedBy/At)", async () => {
  state.profiles = [profileRow({ verificationStatus: "bench_verified", verifiedBy: 9, verifiedAt: new Date() })];
  await caller("admin").updateVerification({ id: 1, verificationStatus: "draft" });
  const patch = state.updates.at(-1)!;
  assert.equal(patch.verificationStatus, "draft");
  assert.equal(patch.verifiedBy, null);
  assert.equal(patch.verifiedAt, null);
});
