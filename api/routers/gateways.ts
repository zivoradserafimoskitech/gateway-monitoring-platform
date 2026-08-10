import { z } from "zod";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { gateways, meters, sites, commands, telemetry, alarms } from "@db/schema";
import { defaultTopicPrefix, defaultTransport } from "@contracts/topics";
import { sendReadNow, getMqttStatus, evictGatewayCache } from "../mqtt/service";
import { clearMeterCache, isDuplicateKey } from "../mqtt/handlers";
import { assertOrgRead, assertOrgWrite, gatewayOrg, orgWhere, stampOrg } from "../lib/org-scope";

export const gatewaysRouter = createRouter({
  mqttStatus: authed.query(() => getMqttStatus()),

  list: authed.query(async ({ ctx }) => {
    const db = getDb();
    // v8/D2: non-superadmin sees only their org's gateways.
    const rows = await db
      .select({
        gateway: gateways,
        siteName: sites.name,
        meterCount: sql<number>`(select count(*) from ${meters} where ${meters.gatewayId} = ${gateways.id})`,
      })
      .from(gateways)
      .leftJoin(sites, eq(gateways.siteId, sites.id))
      .where(orgWhere(ctx.user, gateways.orgId))
      .orderBy(desc(gateways.createdAt));
    return rows.map((r) => ({ ...r.gateway, siteName: r.siteName, meterCount: Number(r.meterCount) }));
  }),

  // v8/D5: heartbeat diagnostics — cheap queries, no loops. lastSeenAt +
  // samples/min over the last 5 min (telemetry rows across the gateway's
  // meters), poller stats for TCP/direct gateways, in-flight OTA jobs.
  diagnostics: authed.input(z.object({ id: z.number() })).query(async ({ input, ctx }) => {
    const db = getDb();
    const gwRows = await db.select().from(gateways).where(eq(gateways.id, input.id)).limit(1);
    const gw = gwRows[0];
    if (!gw) throw new Error("Gateway not found");
    assertOrgRead(ctx.user, gw.orgId, "Gateway");
    const since = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19).replace("T", " ");
    const countRows = await db.execute(sql`
      select count(*) as n
      from telemetry t
      join meters m on m.id = t.meter_id
      where m.gateway_id = ${input.id} and t.ts >= ${since}`);
    const samples5min = Number((countRows as unknown as [Array<{ n: number }>])[0][0]?.n ?? 0);
    const { getPollerStatus } = await import("../poller/service");
    const { activeOtaJobs } = await import("../ota/manager");
    let poller: ReturnType<typeof getPollerStatus>["devices"] | null = null;
    if (gw.transport === "tcp") {
      const idRows = await db.select({ id: meters.id }).from(meters).where(eq(meters.gatewayId, input.id));
      const ids = new Set(idRows.map((r) => r.id));
      poller = getPollerStatus().devices.filter((d) => ids.has(d.id));
    }
    return {
      lastSeenAt: gw.lastSeenAt,
      status: gw.status,
      firmwareVersion: gw.firmwareVersion,
      configVersion: gw.configVersion,
      samples5min,
      msgPerMin: Math.round((samples5min / 5) * 10) / 10,
      poller,
      activeOtaJobs: await activeOtaJobs(input.id),
    };
  }),

  get: authed.input(z.object({ id: z.number() })).query(async ({ input, ctx }) => {
    const db = getDb();
    const gw = await db.select().from(gateways).where(eq(gateways.id, input.id)).limit(1);
    if (!gw[0]) throw new Error("Gateway not found");
    assertOrgRead(ctx.user, gw[0].orgId, "Gateway");
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
    .mutation(async ({ input, ctx }) => {
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
            orgId: stampOrg(ctx.user), // v8/D2
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
    .mutation(async ({ input, ctx }) => {
      assertOrgWrite(ctx.user, await gatewayOrg(input.id), "Gateway");
      const db = getDb();
      const { id, ...patch } = input;
      await db.update(gateways).set(patch).where(eq(gateways.id, id));
      const rows = await db.select().from(gateways).where(eq(gateways.id, id)).limit(1);
      if (rows[0]) evictGatewayCache(rows[0].uid); // #16
      return rows[0];
    }),

  remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    assertOrgWrite(ctx.user, await gatewayOrg(input.id), "Gateway");
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
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const rows = await db.select().from(gateways).where(eq(gateways.id, input.gatewayId)).limit(1);
      if (!rows[0]) throw new Error("Gateway not found");
      assertOrgWrite(ctx.user, rows[0].orgId, "Gateway");
      return sendReadNow(rows[0], input.meterId);
    }),
});
