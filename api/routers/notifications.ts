// v7/C2: notification channels + maintenance windows management.
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { maintenanceWindows, notificationChannels, alarmNotifications, sites } from "@db/schema";
import { invalidateMaintenanceCache } from "../alarms/notify";

const targetFor = (type: "webhook" | "telegram" | "email") =>
  type === "webhook"
    ? z.string().url().max(1000)
    : type === "telegram"
      ? z.string().regex(/^[^:]{20,}:[^:]{3,}$/, "Telegram target must be botToken:chatId").max(1000)
      : z.string().email().max(1000);

export const notificationsRouter = createRouter({
  channels: authed.query(async () => {
    return getDb().select().from(notificationChannels).orderBy(desc(notificationChannels.createdAt));
  }),

  createChannel: operator
    .input(
      z.object({
        name: z.string().min(1).max(255),
        type: z.enum(["webhook", "telegram", "email"]),
        target: z.string().min(1).max(1000),
        escalation: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      targetFor(input.type).parse(input.target);
      const inserted = await getDb()
        .insert(notificationChannels)
        .values({ name: input.name, type: input.type, target: input.target, escalation: input.escalation ? 1 : 0 })
        .$returningId();
      return { id: inserted[0].id };
    }),

  toggleChannel: operator
    .input(z.object({ id: z.number(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await getDb().update(notificationChannels).set({ enabled: input.enabled ? 1 : 0 }).where(eq(notificationChannels.id, input.id));
      return { ok: true };
    }),

  removeChannel: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    await getDb().delete(alarmNotifications).where(eq(alarmNotifications.channelId, input.id));
    await getDb().delete(notificationChannels).where(eq(notificationChannels.id, input.id));
    return { ok: true };
  }),

  deliveries: authed
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      return getDb().select().from(alarmNotifications).orderBy(desc(alarmNotifications.createdAt)).limit(input.limit);
    }),

  maintenance: authed.query(async () => {
    const db = getDb();
    const rows = await db
      .select({ window: maintenanceWindows, siteName: sites.name })
      .from(maintenanceWindows)
      .leftJoin(sites, eq(maintenanceWindows.siteId, sites.id))
      .orderBy(desc(maintenanceWindows.createdAt));
    return rows.map((r) => ({ ...r.window, siteName: r.siteName }));
  }),

  createMaintenance: operator
    .input(
      z.object({
        siteId: z.number().nullable().optional(),
        startsAt: z.date(),
        endsAt: z.date(),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.endsAt <= input.startsAt) throw new Error("endsAt must be after startsAt");
      const inserted = await getDb()
        .insert(maintenanceWindows)
        .values({ siteId: input.siteId ?? null, startsAt: input.startsAt, endsAt: input.endsAt, note: input.note ?? null })
        .$returningId();
      invalidateMaintenanceCache();
      return { id: inserted[0].id };
    }),

  removeMaintenance: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    await getDb().delete(maintenanceWindows).where(eq(maintenanceWindows.id, input.id));
    invalidateMaintenanceCache();
    return { ok: true };
  }),
});
