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
import {
  alarmNotifications,
  alarmRules,
  alarmSuppressions,
  maintenanceWindows,
  notificationChannels,
  onCallShifts,
  sites,
} from "@db/schema";
import { invalidateMaintenanceCache, parseTelegramTarget } from "../alarms/notify";
import { parseEgressUrl, BlockedEgressError } from "../lib/egress";
import { isSuper, stampOrg, assertRowOrg, meterOrg, siteOrg, assertOrgWrite } from "../lib/org-scope";
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

  // ─── §9.8 targeted suppression ─────────────────────────────────────────────
  // Narrower than a maintenance window, and different in kind: a suppressed
  // alarm is still raised and still appears in history carrying the reason it
  // was not sent. "Do not wake anyone" is not the same instruction as "pretend
  // it did not happen", and only the first of the two is ever what an engineer
  // standing at a misbehaving inverter actually means.
  suppressions: authed.query(async ({ ctx }) => {
    return getDb()
      .select()
      .from(alarmSuppressions)
      .where(visibleOrg(ctx.user, alarmSuppressions.orgId))
      .orderBy(desc(alarmSuppressions.createdAt));
  }),

  createSuppression: operator
    .input(
      z.object({
        scope: z.enum(["rule", "meter", "site"]),
        refId: z.number().int().positive(),
        startsAt: z.date(),
        endsAt: z.date(),
        // Required, and required to be non-blank: a suppression with no reason
        // is how an installation ends up permanently quiet with nobody
        // remembering why.
        reason: z.string().trim().min(1).max(255),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.endsAt <= input.startsAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "endsAt must be after startsAt" });
      }
      // Silencing something requires the right to administer it — otherwise a
      // tenant could mute another tenant's devices by guessing ids.
      if (input.scope === "meter") {
        assertOrgWrite(ctx.user, await meterOrg(input.refId), "Device");
      } else if (input.scope === "site") {
        assertOrgWrite(ctx.user, await siteOrg(input.refId), "Site");
      } else {
        const rows = await getDb()
          .select({ orgId: alarmRules.orgId })
          .from(alarmRules)
          .where(eq(alarmRules.id, input.refId))
          .limit(1);
        assertOrgWrite(ctx.user, rows[0] ? rows[0].orgId : undefined, "Alarm rule");
      }
      const inserted = await getDb()
        .insert(alarmSuppressions)
        .values({
          scope: input.scope,
          refId: input.refId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          reason: input.reason,
          createdBy: ctx.user?.id ?? null,
          orgId: stampOrg(ctx.user, null),
        })
        .$returningId();
      return { id: inserted[0].id };
    }),

  removeSuppression: operator.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const rows = await db
      .select({ orgId: alarmSuppressions.orgId })
      .from(alarmSuppressions)
      .where(eq(alarmSuppressions.id, input.id))
      .limit(1);
    if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Suppression not found" });
    assertMayWrite(ctx.user, rows[0].orgId, "Suppression");
    await db.delete(alarmSuppressions).where(eq(alarmSuppressions.id, input.id));
    return { ok: true };
  }),

  // ─── §9.8 on-call rota ─────────────────────────────────────────────────────
  // Opt-in by construction: an org with no enabled shifts keeps the pre-rota
  // behaviour and every channel is notified. Dispatch also fails open on an
  // hour nobody covers — a duplicate page is recoverable, a missed one is not.
  onCall: authed.query(async ({ ctx }) => {
    const rows = await getDb()
      .select({ shift: onCallShifts, channelName: notificationChannels.name })
      .from(onCallShifts)
      .leftJoin(notificationChannels, eq(onCallShifts.channelId, notificationChannels.id))
      .where(visibleOrg(ctx.user, onCallShifts.orgId))
      .orderBy(desc(onCallShifts.createdAt));
    return rows.map((r) => ({ ...r.shift, channelName: r.channelName }));
  }),

  createShift: operator
    .input(
      z.object({
        channelId: z.number().int().positive(),
        // Bit 0 = Sunday, same shape as ems_schedules. 127 = every day.
        dayOfWeekMask: z.number().int().min(0).max(127).default(127),
        startMin: z.number().int().min(0).max(1439).default(0),
        // Equal start and end means all day; end < start wraps past midnight.
        endMin: z.number().int().min(0).max(1439).default(0),
        timezone: z.string().min(1).max(64).default("UTC"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.dayOfWeekMask === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A shift on no day of the week would never be on duty",
        });
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown timezone: ${input.timezone}` });
      }
      const db = getDb();
      const ch = await db
        .select({ orgId: notificationChannels.orgId })
        .from(notificationChannels)
        .where(eq(notificationChannels.id, input.channelId))
        .limit(1);
      if (!ch[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
      assertMayWrite(ctx.user, ch[0].orgId, "Channel");
      const inserted = await db
        .insert(onCallShifts)
        .values({
          channelId: input.channelId,
          dayOfWeekMask: input.dayOfWeekMask,
          startMin: input.startMin,
          endMin: input.endMin,
          timezone: input.timezone,
          orgId: stampOrg(ctx.user, null),
        })
        .$returningId();
      return { id: inserted[0].id };
    }),

  toggleShift: operator
    .input(z.object({ id: z.number(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db
        .select({ orgId: onCallShifts.orgId })
        .from(onCallShifts)
        .where(eq(onCallShifts.id, input.id))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Shift not found" });
      assertMayWrite(ctx.user, rows[0].orgId, "Shift");
      await db.update(onCallShifts).set({ enabled: input.enabled }).where(eq(onCallShifts.id, input.id));
      return { ok: true };
    }),

  removeShift: operator.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const rows = await db
      .select({ orgId: onCallShifts.orgId })
      .from(onCallShifts)
      .where(eq(onCallShifts.id, input.id))
      .limit(1);
    if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Shift not found" });
    assertMayWrite(ctx.user, rows[0].orgId, "Shift");
    await db.delete(onCallShifts).where(eq(onCallShifts.id, input.id));
    return { ok: true };
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
