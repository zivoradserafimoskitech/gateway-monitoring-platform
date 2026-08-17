// Wave 5 / T2: profiles.previewImport / importCsv / exportCsv endpoint tests.
// DB is faked (drizzle-shaped) and the live Modbus read is mocked — no real
// device, no real DB. Pins: sourceDocument required, whole-import rejection on
// row errors, imported profile is ALWAYS draft + source=vendor, writable rows
// land in the controllable whitelist, RBAC (viewer may export, not import),
// export→import round-trip through the endpoints.
import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { TRPCError } from "@trpc/server";
import { deviceProfiles, meters } from "@db/schema";
import { parseProfileCsv } from "../profile-import/csv";

const state = vi.hoisted(() => ({
  db: null as unknown,
  profiles: [] as Array<Record<string, unknown>>,
  meters: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  live: { ok: true, values: {} as Record<string, { key: string; raw?: number; value?: number; error?: string }>, error: undefined as string | undefined },
  liveCalls: [] as Array<{ meterId: number; defCount: number }>,
}));

vi.mock("../queries/connection", () => ({ getDb: () => state.db }));
vi.mock("../mqtt/handlers", () => ({ invalidateProfileCache: () => undefined }));
vi.mock("../profile-import/preview", () => ({
  readDeviceRegisters: async (meter: { id: number }, defs: unknown[]) => {
    state.liveCalls.push({ meterId: meter.id, defCount: defs.length });
    return state.live;
  },
}));

import { profilesRouter } from "./profiles";

/** Fake drizzle client keyed by the table passed to .from(). */
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
      from: (table: unknown) =>
        makeQuery(
          table === meters
            ? state.meters
            : // After a successful insert the router re-fetches the row by id —
              // the fake "persists" it, so pre-insert (duplicate check) sees [].
              state.inserts.length > 0
              ? [{ id: 42, model: state.inserts[0].model }]
              : state.profiles,
        ),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === deviceProfiles) state.inserts.push(v);
        return {
          $returningId: async () => [{ id: 42 }],
          catch: () => undefined, // RBAC fire-and-forget audit insert
        };
      },
    }),
  };
}

const HEADER = "key,address,fc,type,scale,unit,writable,min,max,description";
const CSV = `${HEADER}
socPercent,13022,3,u16,0.1,%,false,,,Battery SOC
activePowerSetpointKw,13051,6,i16,0.1,kW,true,-100,100,Power command`;

const IMPORT_INPUT = {
  csv: CSV,
  model: "vendor-x-bess-100",
  label: "Vendor X BESS 100kW",
  sourceDocument: "Vendor X Modbus Interface Definition, Rev 2.1",
  brand: "VendorX",
  deviceType: "bess" as const,
};

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
  state.profiles = [];
  state.meters = [{ id: 5, orgId: 1, host: "192.0.2.10", port: 502, unitId: 1, modbusAddress: 1, model: "x" }];
  state.inserts = [];
  state.live = { ok: true, values: {}, error: undefined };
  state.liveCalls = [];
  fakeDb();
});

// ─── importCsv ──────────────────────────────────────────────────────────────

test("importCsv: missing/blank sourceDocument → BAD_REQUEST, nothing inserted", async () => {
  await assert.rejects(
    caller("operator").importCsv({ ...IMPORT_INPUT, sourceDocument: "" }),
    (e: Error) => e instanceof TRPCError && e.code === "BAD_REQUEST" && /sourceDocument is required/.test(e.message),
  );
  await assert.rejects(
    caller("operator").importCsv({ ...IMPORT_INPUT, sourceDocument: "   " }),
    (e: Error) => e instanceof TRPCError && e.code === "BAD_REQUEST",
  );
  assert.equal(state.inserts.length, 0);
});

test("importCsv: row-level validation errors reject the WHOLE import with an error list", async () => {
  const badCsv = `${HEADER}\nsoc,13022,3,u16,0.1,%,false,,,x\nsoc2,13022,3,u16,1,,false,,,overlap`;
  await assert.rejects(
    caller("operator").importCsv({ ...IMPORT_INPUT, csv: badCsv }),
    (e: Error) => {
      if (!(e instanceof TRPCError) || e.code !== "BAD_REQUEST") return false;
      const payload = JSON.parse(e.message);
      return Array.isArray(payload.errors) && payload.errors.some((x: { message: string }) => /overlapping addresses/.test(x.message));
    },
  );
  assert.equal(state.inserts.length, 0); // nothing was imported
});

test("importCsv: writable row without min/max is rejected with the nameplate message", async () => {
  const badCsv = `${HEADER}\nsp,10,6,i16,0.1,kW,true,,,Power`;
  await assert.rejects(
    caller("operator").importCsv({ ...IMPORT_INPUT, csv: badCsv }),
    (e: Error) => e instanceof TRPCError && /requires BOTH min and max/.test(e.message),
  );
  assert.equal(state.inserts.length, 0);
});

test("importCsv: success inserts a DRAFT vendor profile; writable rows land in controllable", async () => {
  // (post-insert re-fetch is served by the fake once the insert lands)
  const result = await caller("operator").importCsv(IMPORT_INPUT);
  assert.equal(result?.id, 42);
  assert.equal(state.inserts.length, 1);
  const row = state.inserts[0];
  assert.equal(row.verificationStatus, "draft");
  assert.equal(row.source, "vendor");
  assert.equal(row.sourceDocument, IMPORT_INPUT.sourceDocument);
  assert.equal(row.deviceType, "bess");
  const registerMap = row.registerMap as Array<{ key: string }>;
  const controllable = row.controllable as Record<string, { address: number; min: number; max: number }>;
  assert.deepEqual(registerMap.map((d) => d.key), ["socPercent"]);
  assert.deepEqual(Object.keys(controllable), ["activePowerSetpointKw"]);
  assert.equal(controllable.activePowerSetpointKw.min, -100);
  assert.equal(controllable.activePowerSetpointKw.max, 100);
});

test("importCsv: duplicate model → CONFLICT", async () => {
  state.profiles = [{ id: 1, model: IMPORT_INPUT.model }];
  await assert.rejects(
    caller("operator").importCsv(IMPORT_INPUT),
    (e: Error) => e instanceof TRPCError && e.code === "CONFLICT",
  );
  assert.equal(state.inserts.length, 0);
});

test("importCsv: viewer is FORBIDDEN; anonymous is UNAUTHORIZED", async () => {
  await assert.rejects(
    caller("viewer").importCsv(IMPORT_INPUT),
    (e: Error) => e instanceof TRPCError && e.code === "FORBIDDEN",
  );
  await assert.rejects(
    caller(null).importCsv(IMPORT_INPUT),
    (e: Error) => e instanceof TRPCError && e.code === "UNAUTHORIZED",
  );
  assert.equal(state.inserts.length, 0);
});

// ─── previewImport ──────────────────────────────────────────────────────────

test("previewImport: parses, auto-detects mapping, validates — without touching the DB", async () => {
  const res = await caller("operator").previewImport({ csv: CSV });
  assert.deepEqual(res.errors, []);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].key, "socPercent");
  assert.deepEqual(res.rows[0].errors, []);
  assert.equal(res.mapping.key, "key");
  assert.equal(state.liveCalls.length, 0); // no deviceId → no live read
});

test("previewImport: synonym + reordered headers are tolerated; row errors inline", async () => {
  const csv = "Description,Addr,Key,FC,Type,Scale\nBattery SOC,13022,socPercent,3,uint16,0.1\nBad,13022,soc2,3,uint16,0.1";
  const res = await caller("operator").previewImport({ csv });
  assert.equal(res.rows.length, 2);
  assert.ok(res.rows[1].errors.some((m) => /overlapping addresses/.test(m)));
});

test("previewImport: with deviceId reads live values through the decode path (mocked)", async () => {
  state.live = { ok: true, values: { socPercent: { key: "socPercent", raw: 655, value: 65.5 } }, error: undefined };
  const res = await caller("operator").previewImport({ csv: CSV, deviceId: 5 });
  assert.equal(state.liveCalls.length, 1);
  assert.equal(state.liveCalls[0].meterId, 5);
  assert.deepEqual(res.rows[0].live, { key: "socPercent", raw: 655, value: 65.5 });
  assert.equal(res.rows[1].live, undefined); // write-only row is never read
});

test("previewImport: device-level read failure surfaces as liveError, not a thrown error", async () => {
  state.live = { ok: false, values: {}, error: "connect ECONNREFUSED" };
  const res = await caller("operator").previewImport({ csv: CSV, deviceId: 5 });
  assert.equal(res.liveError, "connect ECONNREFUSED");
});

test("previewImport: unknown device → NOT_FOUND", async () => {
  state.meters = [];
  await assert.rejects(
    caller("operator").previewImport({ csv: CSV, deviceId: 999 }),
    (e: Error) => e instanceof TRPCError && e.code === "NOT_FOUND",
  );
});

// ─── exportCsv ──────────────────────────────────────────────────────────────

test("exportCsv: viewer MAY export; returns canonical CSV with writable rows flattened", async () => {
  const parsed = parseProfileCsv(CSV);
  assert.deepEqual(parsed.errors, []);
  const { rowsToProfileMaps } = await import("../profile-import/csv");
  const maps = rowsToProfileMaps(parsed.rows);
  state.profiles = [{ id: 7, model: "vendor-x-bess-100", registerMap: maps.registerMap, controllable: maps.controllable }];
  const res = await caller("viewer").exportCsv({ id: 7 });
  assert.equal(res.filename, "vendor-x-bess-100.csv");
  const lines = res.csv.trim().split("\n");
  assert.equal(lines[0], HEADER);
  assert.ok(lines.some((l) => l.startsWith("activePowerSetpointKw,13051,6,i16,0.1,kW,true,-100,100")));
  // round-trip through the parser: the exported CSV re-imports cleanly
  const back = parseProfileCsv(res.csv);
  assert.deepEqual(back.errors, []);
  assert.equal(back.rows.length, 2);
});

test("exportCsv: unknown profile → NOT_FOUND; anonymous → UNAUTHORIZED", async () => {
  await assert.rejects(
    caller("viewer").exportCsv({ id: 999 }),
    (e: Error) => e instanceof TRPCError && e.code === "NOT_FOUND",
  );
  await assert.rejects(
    caller(null).exportCsv({ id: 7 }),
    (e: Error) => e instanceof TRPCError && e.code === "UNAUTHORIZED",
  );
});
