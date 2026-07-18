import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { gateways, meters, sites, commands } from "@db/schema";
import { defaultTopicPrefix, defaultTransport } from "@contracts/topics";
import { sendReadNow, getMqttStatus } from "../mqtt/service";

export const gatewaysRouter = createRouter({
  mqttStatus: publicQuery.query(() => getMqttStatus()),

  list: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        gateway: gateways,
        siteName: sites.name,
        meterCount: sql<number>`(select count(*) from ${meters} where ${meters.gatewayId} = ${gateways.id})`,
      })
      .from(gateways)
      .leftJoin(sites, eq(gateways.siteId, sites.id))
      .orderBy(desc(gateways.createdAt));
    return rows.map((r) => ({ ...r.gateway, siteName: r.siteName, meterCount: Number(r.meterCount) }));
  }),

  get: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const gw = await db.select().from(gateways).where(eq(gateways.id, input.id)).limit(1);
    if (!gw[0]) throw new Error("Gateway not found");
    const meterRows = await db
      .select()
      .from(meters)
      .where(eq(meters.gatewayId, input.id))
      .orderBy(meters.modbusAddress);
    const cmdRows = await db
      .select()
      .from(commands)
      .where(eq(commands.gatewayId, input.id))
      .orderBy(desc(commands.createdAt))
      .limit(20);
    return { gateway: gw[0], meters: meterRows, commands: cmdRows };
  }),

  create: publicQuery
    .input(
      z.object({
        uid: z.string().min(4).max(64),
        name: z.string().min(1).max(255),
        model: z.enum(["G30", "C30"]),
        siteId: z.number().optional().nullable(),
        topicPrefix: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.select().from(gateways).where(eq(gateways.uid, input.uid)).limit(1);
      if (existing[0]) throw new Error("A gateway with this UID already exists");
      const inserted = await db
        .insert(gateways)
        .values({
          uid: input.uid,
          name: input.name,
          model: input.model,
          transport: defaultTransport(input.model),
          topicPrefix: input.topicPrefix?.trim() || defaultTopicPrefix(input.model),
          siteId: input.siteId ?? null,
        })
        .$returningId();
      const rows = await db.select().from(gateways).where(eq(gateways.id, inserted[0].id)).limit(1);
      return rows[0];
    }),

  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        siteId: z.number().nullable().optional(),
        topicPrefix: z.string().max(255).optional(),
        firmware: z.string().max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...patch } = input;
      await db.update(gateways).set(patch).where(eq(gateways.id, id));
      const rows = await db.select().from(gateways).where(eq(gateways.id, id)).limit(1);
      return rows[0];
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(meters).where(eq(meters.gatewayId, input.id));
    await db.delete(gateways).where(eq(gateways.id, input.id));
    return { ok: true };
  }),

  readNow: publicQuery
    .input(z.object({ gatewayId: z.number(), meterId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(gateways).where(eq(gateways.id, input.gatewayId)).limit(1);
      if (!rows[0]) throw new Error("Gateway not found");
      return sendReadNow(rows[0], input.meterId);
    }),
});
