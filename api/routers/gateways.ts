import { z } from "zod";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { gateways, meters, sites, commands, telemetry, alarms } from "@db/schema";
import { defaultTopicPrefix, defaultTransport } from "@contracts/topics";
import { sendReadNow, getMqttStatus, evictGatewayCache } from "../mqtt/service";
import { clearMeterCache, isDuplicateKey } from "../mqtt/handlers";

export const gatewaysRouter = createRouter({
  mqttStatus: authed.query(() => getMqttStatus()),

  list: authed.query(async () => {
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

  get: authed.input(z.object({ id: z.number() })).query(async ({ input }) => {
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

  create: operator
    .input(
      z.object({
        // v6/R1: uid becomes part of every MQTT topic for this gateway —
        // restrict to topic-safe chars or the uplink can never be parsed.
        uid: z
          .string()
          .trim()
          .regex(
            /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/,
            "UID must be 4-64 chars: letters, digits, '-' or '_', starting with a letter/digit",
          ),
        name: z.string().min(1).max(255),
        model: z.enum(["G30", "C30"]),
        siteId: z.number().optional().nullable(),
        topicPrefix: z
          .string()
          .trim()
          .max(255)
          .regex(/^[A-Za-z0-9_/-]*$/, "Topic prefix may only contain letters, digits, '-', '_' or '/'")
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.select().from(gateways).where(eq(gateways.uid, input.uid)).limit(1);
      if (existing[0]) throw new Error("A gateway with this UID already exists");
      let inserted: { id: number }[];
      try {
        inserted = await db
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
      } catch (err) {
        // v6/R2: concurrent creates race past the pre-check — translate the
        // unique-index violation into the same friendly message.
        if (isDuplicateKey(err)) throw new Error("A gateway with this UID already exists");
        throw err;
      }
      const rows = await db.select().from(gateways).where(eq(gateways.id, inserted[0].id)).limit(1);
      return rows[0];
    }),

  update: operator
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
      if (rows[0]) evictGatewayCache(rows[0].uid); // #16
      return rows[0];
    }),

  remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    // Full cascade (v4 review #1): meters' telemetry + alarms must go with them,
    // otherwise rows orphan permanently (no FK constraints in the schema).
    const gwRows = await db.select({ uid: gateways.uid }).from(gateways).where(eq(gateways.id, input.id)).limit(1);
    const meterRows = await db.select({ id: meters.id }).from(meters).where(eq(meters.gatewayId, input.id));
    const ids = meterRows.map((m) => m.id);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await db.delete(telemetry).where(inArray(telemetry.meterId, chunk));
      await db.delete(alarms).where(inArray(alarms.meterId, chunk));
    }
    if (ids.length) await db.delete(meters).where(inArray(meters.id, ids));
    await db.delete(gateways).where(eq(gateways.id, input.id));
    // #16: drop cached rows so the ingestion path can't resurrect this gateway
    // or its meters for the remaining cache TTL.
    if (gwRows[0]) evictGatewayCache(gwRows[0].uid);
    clearMeterCache();
    return { ok: true, removedMeters: ids.length };
  }),

  readNow: operator
    .input(z.object({ gatewayId: z.number(), meterId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(gateways).where(eq(gateways.id, input.gatewayId)).limit(1);
      if (!rows[0]) throw new Error("Gateway not found");
      return sendReadNow(rows[0], input.meterId);
    }),
});
