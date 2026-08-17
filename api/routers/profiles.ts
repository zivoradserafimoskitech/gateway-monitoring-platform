import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator, admin } from "../middleware";
import { getDb } from "../queries/connection";
import { deviceProfiles, sites, gateways, meters } from "@db/schema";
import { type RegisterDef } from "@contracts/modbus";
import { DEVICE_TYPES } from "@contracts/devices";
import { invalidateProfileCache } from "../mqtt/handlers";
import { assertOrgRead, assertOrgWrite, meterOrg, orgWhere, siteOrg, stampOrg } from "../lib/org-scope";
import {
  CANONICAL_COLUMNS,
  parseProfileCsv,
  validateImportRows,
  rowsToProfileMaps,
  profileMapsToCsv,
  type ColumnMapping,
  type ImportError,
} from "../profile-import/csv";
import { readDeviceRegisters, type LiveValue } from "../profile-import/preview";
import { computeReadFlags, hasPowerSetpoint, nameplateAbsMax } from "../profile-import/verify";
import {
  ControlError,
  executeAndLog,
  UNVERIFIED_OVERRIDE_WARNING,
  type ControllableMap,
} from "../control/execute";

// v7/C8: reject non-IANA timezones at the API boundary (Intl is the validator).
function assertValidTz(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Invalid IANA timezone: "${tz}" (e.g. Europe/Skopje, UTC)`);
  }
}

const registerDefSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  address: z.number().int().min(0).max(65535),
  functionCode: z.union([z.literal(3), z.literal(4)]),
  type: z.enum(["float32", "u32", "i32", "u16", "i16"]),
  scale: z.number(),
  unit: z.string().max(16),
  wordSwap: z.boolean().optional(),
  // v3 codec extensions — MUST round-trip through the UI editor or ESMU-style
  // biased/strided maps silently break on save (v4 review finding #6).
  offset: z.number().optional(),
  addressStride: z
    .object({
      firstUnit: z.number().int().min(1),
      stride: z.number().int().min(1),
    })
    .optional(),
});

export const profilesRouter = createRouter({
  list: authed.query(async () => {
    const db = getDb();
    return db.select().from(deviceProfiles).orderBy(deviceProfiles.model);
  }),

  updateMap: operator
    .input(
      z.object({
        id: z.number(),
        registerMap: z.array(registerDefSchema).min(1),
        label: z.string().min(1).max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(deviceProfiles)
        .set({
          registerMap: input.registerMap as RegisterDef[],
          ...(input.label ? { label: input.label } : {}),
        })
        .where(eq(deviceProfiles.id, input.id));
      invalidateProfileCache();
      const rows = await db.select().from(deviceProfiles).where(eq(deviceProfiles.id, input.id)).limit(1);
      return rows[0];
    }),

  // Wave 5 / T1: verification state + commissioning override. ADMIN ONLY —
  // allowUnverifiedControl bypasses the draft-profile control gate, so an
  // operator must not be able to flip it. Status transitions offered here:
  //   → field_verified: manual admin action after live-site runtime
  //     (records verifiedBy = current user, verifiedAt = now);
  //   → draft: revert (clears verifiedBy/verifiedAt).
  // bench_verified is deliberately NOT settable here — it is earned through
  // the guided bench-verification workflow (Task 3), never by a shortcut.
  updateVerification: admin
    .input(
      z.object({
        id: z.number(),
        allowUnverifiedControl: z.boolean().optional(),
        verificationStatus: z.enum(["draft", "field_verified"]).optional(),
        verifiedNotes: z.string().max(4000).nullable().optional(),
        sourceDocument: z.string().max(500).nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const existing = await db.select().from(deviceProfiles).where(eq(deviceProfiles.id, input.id)).limit(1);
      if (!existing[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found" });
      const patch: Partial<typeof deviceProfiles.$inferInsert> = {};
      if (input.allowUnverifiedControl !== undefined) patch.allowUnverifiedControl = input.allowUnverifiedControl;
      if (input.verificationStatus !== undefined) {
        patch.verificationStatus = input.verificationStatus;
        if (input.verificationStatus === "field_verified") {
          patch.verifiedBy = ctx.user?.id ?? null;
          patch.verifiedAt = new Date();
        } else {
          // revert to draft — the previous verification no longer applies
          patch.verifiedBy = null;
          patch.verifiedAt = null;
        }
      }
      if (input.verifiedNotes !== undefined) patch.verifiedNotes = input.verifiedNotes;
      if (input.sourceDocument !== undefined) patch.sourceDocument = input.sourceDocument;
      await db.update(deviceProfiles).set(patch).where(eq(deviceProfiles.id, input.id));
      invalidateProfileCache();
      const rows = await db.select().from(deviceProfiles).where(eq(deviceProfiles.id, input.id)).limit(1);
      return rows[0];
    }),

  // ─── Wave 5 / T2: CSV import/export — adding a vendor is data entry ──────
  //
  // previewImport: parse + validate the CSV and (optionally) read a live
  // device's CURRENT values for each row through the poller's decode path, so
  // a wrong scale or byte order is visible BEFORE anything is saved.
  previewImport: operator
    .input(
      z.object({
        csv: z.string().min(1).max(2_000_000),
        // canonical column → spreadsheet header; missing entries auto-detect
        mapping: z.record(z.string(), z.string()).optional(),
        deviceId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const parsed = parseProfileCsv(input.csv, sanitizeMapping(input.mapping));
      const rowErrors = validateImportRows(parsed.rows);
      const errorsByRow = new Map<number, string[]>();
      const globalErrors: string[] = [];
      for (const e of [...parsed.errors, ...rowErrors]) {
        if (e.row === 0) globalErrors.push(e.message);
        else {
          const list = errorsByRow.get(e.row) ?? [];
          list.push(e.message);
          errorsByRow.set(e.row, list);
        }
      }

      let live: Record<string, LiveValue> | undefined;
      let liveError: string | undefined;
      if (input.deviceId !== undefined) {
        const db = getDb();
        const m = await db.select().from(meters).where(eq(meters.id, input.deviceId)).limit(1);
        if (!m[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
        assertOrgRead(ctx.user, await meterOrg(input.deviceId), "Device");
        const { registerMap } = rowsToProfileMaps(parsed.rows);
        const res = await readDeviceRegisters(m[0], registerMap);
        live = res.values;
        liveError = res.error;
      }

      return {
        headers: parsed.headers,
        mapping: parsed.mapping,
        rows: parsed.rows.map((r) => ({
          ...r,
          errors: errorsByRow.get(r.row) ?? [],
          live: live?.[r.key],
        })),
        errors: globalErrors,
        liveError,
      };
    }),

  // importCsv: validate, then insert as a DRAFT profile with source="vendor".
  // sourceDocument is REQUIRED (constraint #5) — when a map turns out wrong
  // six months later, the first question is which document it came from.
  importCsv: operator
    .input(
      z.object({
        csv: z.string().min(1).max(2_000_000),
        mapping: z.record(z.string(), z.string()).optional(),
        model: z.string().min(1).max(128),
        label: z.string().min(1).max(255),
        sourceDocument: z.string().max(500),
        brand: z.string().max(64).optional(),
        deviceType: z.enum(DEVICE_TYPES).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const sourceDocument = input.sourceDocument.trim();
      if (!sourceDocument) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "sourceDocument is required — record the vendor document and revision this register map was " +
            "transcribed from (e.g. 'Vendor X Modbus Interface Definition, Rev 2.1').",
        });
      }
      const parsed = parseProfileCsv(input.csv, sanitizeMapping(input.mapping));
      const errors: ImportError[] = [...parsed.errors, ...validateImportRows(parsed.rows)];
      if (errors.length > 0 || parsed.rows.length === 0) {
        if (parsed.rows.length === 0 && errors.length === 0) {
          errors.push({ row: 0, message: "no register rows parsed" });
        }
        // Reject the WHOLE import with the row-level error list (JSON in the
        // message — the UI pre-validates via previewImport, this is the net).
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: JSON.stringify({ message: "CSV import failed validation — nothing was imported", errors }),
        });
      }
      const db = getDb();
      const existing = await db.select().from(deviceProfiles).where(eq(deviceProfiles.model, input.model)).limit(1);
      if (existing[0]) {
        throw new TRPCError({ code: "CONFLICT", message: `a profile with model '${input.model}' already exists` });
      }
      const { registerMap, controllable } = rowsToProfileMaps(parsed.rows);
      const inserted = await db
        .insert(deviceProfiles)
        .values({
          model: input.model,
          label: input.label,
          brand: input.brand ?? null,
          deviceType: input.deviceType ?? "bess",
          protocol: "rtu",
          source: "vendor",
          sourceDocument,
          registerMap,
          controllable: Object.keys(controllable).length > 0 ? controllable : null,
          // Always draft — control stays blocked until the bench-verification
          // workflow (Task 3) promotes the profile.
          verificationStatus: "draft",
        })
        .$returningId();
      invalidateProfileCache();
      const rows = await db.select().from(deviceProfiles).where(eq(deviceProfiles.id, inserted[0].id)).limit(1);
      return rows[0];
    }),

  // exportCsv: flatten a profile back to the canonical CSV (sharing a verified
  // map between installations, diffing after a vendor firmware revision).
  // Viewers may export — this is a read.
  exportCsv: authed.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const rows = await db.select().from(deviceProfiles).where(eq(deviceProfiles.id, input.id)).limit(1);
    const profile = rows[0];
    if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found" });
    const registerMap = (typeof profile.registerMap === "string"
      ? JSON.parse(profile.registerMap as string)
      : profile.registerMap) as RegisterDef[];
    const controllable = (typeof profile.controllable === "string"
      ? JSON.parse(profile.controllable as string)
      : profile.controllable) as Parameters<typeof profileMapsToCsv>[1];
    return {
      filename: `${profile.model}.csv`,
      csv: profileMapsToCsv(registerMap, controllable),
    };
  }),

  // ─── Wave 5 / T3: bench verification workflow ────────────────────────────
  // The guided path that turns a draft profile into bench_verified. Steps 1–3
  // are operator procedures (an engineer at the cabinet), completion is
  // ADMIN-ONLY. Steps 2–3 deliberately go through the EXISTING control path —
  // on a draft profile that means the T1 gate, so allowUnverifiedControl must
  // be enabled by an admin first, and completion clears it again.

  // Step 1 — read verification: poll EVERY key in the register map via the
  // T2 live-read path and flag declared min/max violations plus scaling-error
  // heuristics (SoC > 100 %, voltage > 1000 V, power beyond the nameplate).
  verifyRead: operator
    .input(z.object({ profileId: z.number(), deviceId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const profile = await loadProfile(input.profileId);
      const meter = await loadMeterForVerify(ctx.user, input.deviceId);
      assertModelMatch(profile, meter);
      const registerMap = parseJson<RegisterDef[]>(profile.registerMap) ?? [];
      const controllable = parseJson<ControllableMap>(profile.controllable);
      const nameplate = nameplateAbsMax(controllable);
      const res = await readDeviceRegisters(meter, registerMap);
      const rows = registerMap.map((def) => {
        const live = res.values[def.key];
        const flags = computeReadFlags(
          { key: def.key, unit: def.unit, min: def.min, max: def.max, value: live?.value },
          nameplate,
        );
        return {
          key: def.key,
          label: def.label,
          unit: def.unit,
          min: def.min,
          max: def.max,
          raw: live?.raw,
          value: live?.value,
          error: live?.error,
          inRange:
            live?.value === undefined || (def.min === undefined && def.max === undefined)
              ? null
              : !flags.includes("out_of_range"),
          flags,
        };
      });
      return { ok: res.ok, error: res.error, nameplateAbsMax: nameplate ?? null, rows };
    }),

  // Step 2 — sign convention: record the operator's answer to "we commanded a
  // small discharge; does batteryPowerKw read positive or negative?" on the
  // profile. The discharge command itself goes through control.execute — on a
  // draft profile that requires allowUnverifiedControl (no bypass here).
  verifySign: operator
    .input(z.object({ profileId: z.number(), deviceId: z.number(), dischargePositive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const profile = await loadProfile(input.profileId);
      const meter = await loadMeterForVerify(ctx.user, input.deviceId);
      assertModelMatch(profile, meter);
      await db.update(deviceProfiles).set({ dischargePositive: input.dischargePositive }).where(eq(deviceProfiles.id, profile.id));
      invalidateProfileCache();
      const rows = await db.select().from(deviceProfiles).where(eq(deviceProfiles.id, profile.id)).limit(1);
      return rows[0];
    }),

  // Step 3 — control round-trip: write a small safe value for ONE writable
  // key via the existing control path (ALL gates apply — whitelist, range,
  // and the T1 draft gate; a draft profile without the override surfaces the
  // ControlError BY DESIGN), then read the register back and show the raw
  // register value alongside the scaled engineering value.
  verifyControlRoundTrip: operator
    .input(
      z.object({
        profileId: z.number(),
        deviceId: z.number(),
        key: z.string().min(1).max(64),
        value: z.number().finite(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const profile = await loadProfile(input.profileId);
      const meter = await loadMeterForVerify(ctx.user, input.deviceId);
      assertModelMatch(profile, meter);
      const controllable = parseJson<ControllableMap>(profile.controllable) ?? {};
      const def = controllable[input.key];
      if (!def) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `'${input.key}' is not a writable key on profile ${profile.model}` });
      }
      let result;
      try {
        result = await executeAndLog(meter, input.key, input.value, ctx.user?.id ?? null);
      } catch (err) {
        // Draft gate / range / whitelist failures are the DESIGNED behaviour —
        // surface them to the wizard so the operator sees the gate working.
        if (err instanceof ControlError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        throw err;
      }
      // Structured read-back: raw register + scaled value side by side, so a
      // wrong scale is visible (controllable scale is the INVERSE convention:
      // register value = setpoint × scale → engineering value = raw ÷ scale).
      const scale = def.scale ?? 1;
      const expectedRaw = Math.round(input.value * scale);
      let readBack: { raw?: number; value?: number; error?: string } = { error: "read-back not available" };
      if (meter.host) {
        const rb = await readDeviceRegisters(meter, [
          {
            key: input.key,
            label: input.key,
            address: def.address,
            functionCode: 3,
            type: "u16",
            scale: 1 / scale,
            unit: def.unit ?? "",
          },
        ]);
        const live = rb.values[input.key];
        readBack = live?.error ? { error: live.error } : { raw: live?.raw, value: live?.value };
        if (!rb.ok && !live) readBack = { error: rb.error ?? "read-back failed" };
      } else {
        readBack = { error: "bus device — read-back verified asynchronously via the downlink correlation (see command log)" };
      }
      return {
        status: result.status,
        detail: result.detail,
        warning: result.detail.startsWith(UNVERIFIED_OVERRIDE_WARNING),
        key: input.key,
        written: input.value,
        expectedRaw,
        readBack,
      };
    }),

  // Completion — ADMIN ONLY: promote draft → bench_verified, record who/when/
  // what (firmware + serial + tested notes), and CLEAR the commissioning
  // override. Refuses when the profile has a controllable power setpoint but
  // the sign convention was never recorded (dischargePositive IS NULL).
  completeBenchVerification: admin
    .input(
      z.object({
        profileId: z.number(),
        firmwareVersion: z.string().max(120),
        serial: z.string().max(120),
        testedNotes: z.string().max(4000),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const profile = await loadProfile(input.profileId);
      const controllable = parseJson<ControllableMap>(profile.controllable);
      if (hasPowerSetpoint(controllable) && profile.dischargePositive === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Sign convention not recorded — this profile has a controllable power setpoint, so bench " +
            "verification requires the step-2 answer (does batteryPowerKw read positive while discharging?).",
        });
      }
      const verifiedNotes =
        `Firmware: ${input.firmwareVersion.trim() || "—"}\n` +
        `Serial: ${input.serial.trim() || "—"}\n` +
        `Tested: ${input.testedNotes.trim() || "—"}`;
      await db
        .update(deviceProfiles)
        .set({
          verificationStatus: "bench_verified",
          verifiedBy: ctx.user?.id ?? null,
          verifiedAt: new Date(),
          verifiedNotes,
          // The commissioning escape hatch exists for the bench — leaving it
          // on after verification would silently keep every write WARNINGed.
          allowUnverifiedControl: false,
        })
        .where(eq(deviceProfiles.id, profile.id));
      invalidateProfileCache();
      const rows = await db.select().from(deviceProfiles).where(eq(deviceProfiles.id, profile.id)).limit(1);
      return rows[0];
    }),
});

/** Keep only canonical mapping keys; values are header names in the CSV. */
function sanitizeMapping(mapping: Record<string, string> | undefined): ColumnMapping {
  if (!mapping) return {};
  const out: Record<string, string> = {};
  for (const col of CANONICAL_COLUMNS) {
    const v = mapping[col];
    if (typeof v === "string" && v.trim() !== "") out[col] = v;
  }
  return out as ColumnMapping;
}

// ─── Wave 5 / T3 helpers ────────────────────────────────────────────────────

/** TiDB JSON columns can come back as strings — decode defensively. */
function parseJson<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return JSON.parse(v) as T;
  return v as T;
}

async function loadProfile(profileId: number) {
  const rows = await getDb().select().from(deviceProfiles).where(eq(deviceProfiles.id, profileId)).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found" });
  return rows[0];
}

async function loadMeterForVerify(user: Parameters<typeof assertOrgWrite>[0], deviceId: number) {
  const rows = await getDb().select().from(meters).where(eq(meters.id, deviceId)).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
  assertOrgWrite(user, rows[0].orgId, "Device"); // v8/D2
  return rows[0];
}

function assertModelMatch(profile: { model: string }, meter: { model: string }): void {
  if (meter.model !== profile.model) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Device model '${meter.model}' does not match profile '${profile.model}'`,
    });
  }
}

export const sitesRouter = createRouter({
  list: authed.query(async ({ ctx }) => {
    const db = getDb();
    // v8/D2: non-superadmin sees only their org's sites.
    return db.select().from(sites).where(orgWhere(ctx.user, sites.orgId)).orderBy(desc(sites.createdAt));
  }),

  create: operator
    .input(
      z.object({
        name: z.string().min(1).max(255),
        address: z.string().max(500).optional(),
        timezone: z.string().max(64).optional(),
        orgId: z.number().optional(), // v8/D2: superadmin only; others get their own org stamped
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tz = input.timezone?.trim() || "UTC";
      assertValidTz(tz);
      const db = getDb();
      const inserted = await db
        .insert(sites)
        .values({ name: input.name, address: input.address ?? null, timezone: tz, orgId: stampOrg(ctx.user, input.orgId) })
        .$returningId();
      const rows = await db.select().from(sites).where(eq(sites.id, inserted[0].id)).limit(1);
      return rows[0];
    }),

  update: operator
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        address: z.string().max(500).nullable().optional(),
        timezone: z.string().max(64).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...patch } = input;
      if (patch.timezone) assertValidTz(patch.timezone);
      assertOrgWrite(ctx.user, await siteOrg(id), "Site");
      await getDb().update(sites).set(patch).where(eq(sites.id, id));
      return { ok: true };
    }),

  remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    assertOrgWrite(ctx.user, await siteOrg(input.id), "Site");
    const db = getDb();
    // v6/R3: unbind everything that references the site first — otherwise
    // gateways/meters keep an orphaned site_id forever (no FK to enforce it).
    const unboundGateways = await db
      .update(gateways)
      .set({ siteId: null })
      .where(eq(gateways.siteId, input.id));
    const unboundMeters = await db
      .update(meters)
      .set({ siteId: null })
      .where(eq(meters.siteId, input.id));
    await db.delete(sites).where(eq(sites.id, input.id));
    return {
      ok: true,
      unboundGateways: (unboundGateways as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0,
      unboundMeters: (unboundMeters as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0,
    };
  }),
});
