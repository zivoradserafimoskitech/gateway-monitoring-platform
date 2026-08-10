import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { deviceProfiles, sites, gateways, meters } from "@db/schema";
import { type RegisterDef } from "@contracts/modbus";
import { invalidateProfileCache } from "../mqtt/handlers";
import { assertOrgWrite, orgWhere, siteOrg, stampOrg } from "../lib/org-scope";

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
});

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
