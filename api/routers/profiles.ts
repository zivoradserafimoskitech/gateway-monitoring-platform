import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { deviceProfiles, sites } from "@db/schema";
import { METRICS, type RegisterDef } from "@contracts/modbus";
import { invalidateProfileCache } from "../mqtt/handlers";

const registerDefSchema = z.object({
  key: z.enum(METRICS),
  label: z.string().min(1).max(120),
  address: z.number().int().min(0).max(65535),
  functionCode: z.union([z.literal(3), z.literal(4)]),
  type: z.enum(["float32", "u32", "i32", "u16", "i16"]),
  scale: z.number(),
  unit: z.string().max(16),
});

export const profilesRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(deviceProfiles).orderBy(deviceProfiles.model);
  }),

  updateMap: publicQuery
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
  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(sites).orderBy(desc(sites.createdAt));
  }),

  create: publicQuery
    .input(z.object({ name: z.string().min(1).max(255), address: z.string().max(500).optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const inserted = await db
        .insert(sites)
        .values({ name: input.name, address: input.address ?? null })
        .$returningId();
      const rows = await db.select().from(sites).where(eq(sites.id, inserted[0].id)).limit(1);
      return rows[0];
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(sites).where(eq(sites.id, input.id));
    return { ok: true };
  }),
});
