// v7/C2: notification channels + maintenance windows management.
//
// Tenancy: channels, maintenance windows and delivery history are owned by an
// org. A NULL org means "global" — it applies to every tenant, so only a
// superadmin may create or edit one. Before this scoping existed, every
// operator could see and edit every tenant's channels, and alarms were
// dispatched to all of them.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, isNull, or, type Column, type SQL } from "drizzle-orm";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { maintenanceWindows, notificationChannels, alarmNotifications, sites } from "@db/schema";
import { invalidateMaintenanceCache, parseTelegramTarget } from "../alarms/notify";
import { parseEgressUrl, BlockedEgressError } from "../lib/egress";
import { isSuper, stampOrg, assertRowOrg, siteOrg, assertOrgWrite } from "../lib/org-scope";
import type { User } from "@db/schema";

// Validate a channel target for its transport. Throws a tRPC BAD_REQUEST with
// an actionable message rather than a bare zod error.
function validateTarget(type: "webhook" | "telegram" | "email", target: string): void {
  if (target.length > 1000) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Target is too long (max 1000 characters)" });
  }
  if (type === "webhook") {
    try {
      parseEgressUrl(target);
    } catch (e) {
      const msg = e instanceof BlockedEgressError ? e.message : "Target must be a valid URL";
      throw new TRPCError({ code: "BAD_REQUEST", message: msg });
    }
    return;
  }
  if (type === "telegram") {
    // "<botToken>:<chatId>" — the bot token itself contains a colon, so the
    // separator is the last one. The previous regex rejected every real token.
    if (!parseTelegramTarget(target)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Telegram target must be <botToken>:<chatId>, e.g. 123456789:AA...xyz:-1001234567890",
      });
    }
    return;
  }
  if (!z.string().email().safeParse(target).success) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Email target must be a valid address" });
  }
}

// Rows visible to the caller: own org plus global (NULL) rows.
function visibleOrg(user: User | null, column: Column): SQL | undefined {
  if (isSuper(user)) return undefined;
  return or(eq(column, user!.orgId ?? -1), isNull(column));
}

// Only a superadmin may create or modify a global (NULL-org) row.
function assertMayWrite(user: User | null, rowOrgId: number | null, what: string): void {
  if (isSuper(user)) return;
  if (rowOrgId === null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${what} is global and can only be changed by a superadmin`,
    });
  }
  assertRowOrg(user, rowOrgId, what);
}

export const notificationsRouter = createRouter({
  channels: authed.query(async ({ ctx }) => {
    return getDb()
      .select()
      .from(notificationChannels)
      .where(visibleOrg(ctx.user, notificationChannels.orgId))
      .orderBy(desc(notificationChannels.createdAt));
  }),

  createChannel: operator
    .input(
      z.object({
        name: z.string().min(1).max(255),
        type: z.enum(["webhook", "telegram", "email"]),
        target: z.string().min(1).max(1000),
        escalation: z.boolean().default(false),
        // Superadmin only: null creates a global channel.
        orgId: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      validateTarget(input.type, input.target);
      const orgId = stampOrg(ctx.user, input.orgId);
      if (orgId === null && !isSuper(ctx.user)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only a superadmin may create a global channel" });
      }
      const inserted = await getDb()
        .insert(notificationChannels)
        .values({
          name: input.name,
          type: input.type,
          target: input.target,
          escalation: input.escalation ? 1 : 0,
          orgId,
        })
        .$returningId();
      return { id: inserted[0].id };
    }),

  toggleChannel: operator
    .input(z.object({ id: z.number(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db
        .select({ orgId: notificationChannels.orgId })
        .from(notificationChannels)
        .where(eq(notificationChannels.id, input.id))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
      assertMayWrite(ctx.user, rows[0].orgId, "Channel");
      await db
        .update(notificationChannels)
        .set({ enabled: input.enabled ? 1 : 0 })
        .where(eq(notificationChannels.id, input.id));
      return { ok: true };
    }),

  removeChannel: operator.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const rows = await db
      .select({ orgId: notificationChannels.orgId })
      .from(notificationChannels)
      .where(eq(notificationChannels.id, input.id))
      .limit(1);
    if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
    assertMayWrite(ctx.user, rows[0].orgId, "Channel");
    await db.delete(alarmNotifications).where(eq(alarmNotifications.channelId, input.id));
    await db.delete(notificationChannels).where(eq(notificationChannels.id, input.id));
    return { ok: true };
  }),

  deliveries: authed
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      return getDb()
        .select()
        .from(alarmNotifications)
        .where(visibleOrg(ctx.user, alarmNotifications.orgId))
        .orderBy(desc(alarmNotifications.createdAt))
        .limit(input.limit);
    }),

  maintenance: authed.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({ window: maintenanceWindows, siteName: sites.name })
      .from(maintenanceWindows)
      .leftJoin(sites, eq(maintenanceWindows.siteId, sites.id))
      .where(visibleOrg(ctx.user, maintenanceWindows.orgId))
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
    .mutation(async ({ ctx, input }) => {
      if (input.endsAt <= input.startsAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "endsAt must be after startsAt" });
      }
      // A window scoped to a site must be a site the caller can administer.
      if (input.siteId != null) {
        assertOrgWrite(ctx.user, await siteOrg(input.siteId), "Site");
      }
      const orgId = stampOrg(ctx.user, null);
      const inserted = await getDb()
        .insert(maintenanceWindows)
        .values({
          siteId: input.siteId ?? null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          note: input.note ?? null,
          orgId,
        })
        .$returningId();
      invalidateMaintenanceCache();
      return { id: inserted[0].id };
    }),

  removeMaintenance: operator.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const rows = await db
      .select({ orgId: maintenanceWindows.orgId })
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, input.id))
      .limit(1);
    if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Maintenance window not found" });
    assertMayWrite(ctx.user, rows[0].orgId, "Maintenance window");
    await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, input.id));
    invalidateMaintenanceCache();
    return { ok: true };
  }),
});
