// §9.15: outbound webhook subscription management (admin only).
//
// Admin rather than operator, matching api-keys: a subscription is a standing
// export of this tenant's alarm and control history to a third party, which is
// closer to handing out a credential than to configuring a device.
//
// The signing secret is returned EXACTLY once — at creation and on rotation.
// It is stored in plaintext because it must be reproduced to sign each
// delivery, not compared, but there is no reason for a list query to keep
// handing it back afterwards.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createRouter, admin } from "../middleware";
import { getDb } from "../queries/connection";
import { webhookDeliveries, webhookSubscriptions } from "@db/schema";
import { newSecret } from "../webhooks/sign";
import { WEBHOOK_EVENTS } from "@contracts/webhook-events";
import { parseEgressUrl, BlockedEgressError } from "../lib/egress";
import { assertOrgWrite, orgWhere, stampOrg } from "../lib/org-scope";

function validateUrl(url: string): void {
  try {
    parseEgressUrl(url);
  } catch (e) {
    const msg = e instanceof BlockedEgressError ? e.message : "Target must be a valid URL";
    throw new TRPCError({ code: "BAD_REQUEST", message: msg });
  }
}

// Everything except the secret. Listing a signing key on every page load would
// undo the point of showing it once.
const publicColumns = {
  id: webhookSubscriptions.id,
  name: webhookSubscriptions.name,
  url: webhookSubscriptions.url,
  events: webhookSubscriptions.events,
  enabled: webhookSubscriptions.enabled,
  consecutiveFailures: webhookSubscriptions.consecutiveFailures,
  lastSuccessAt: webhookSubscriptions.lastSuccessAt,
  lastErrorAt: webhookSubscriptions.lastErrorAt,
  lastError: webhookSubscriptions.lastError,
  orgId: webhookSubscriptions.orgId,
  createdAt: webhookSubscriptions.createdAt,
};

async function ownRow(id: number, user: Parameters<typeof assertOrgWrite>[0]) {
  const rows = await getDb()
    .select({ orgId: webhookSubscriptions.orgId })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Subscription not found" });
  assertOrgWrite(user, rows[0].orgId, "Subscription");
}

// The event catalogue is not served as a procedure: it lives in contracts/,
// which is compiled into both sides, so the list the screen offers and the list
// the API validates against are the same array rather than two that have to be
// kept in step.
export const webhooksRouter = createRouter({
  list: admin.query(async ({ ctx }) => {
    return getDb()
      .select(publicColumns)
      .from(webhookSubscriptions)
      .where(orgWhere(ctx.user, webhookSubscriptions.orgId))
      .orderBy(desc(webhookSubscriptions.createdAt));
  }),

  create: admin
    .input(
      z.object({
        name: z.string().min(1).max(255),
        url: z.string().min(1).max(1000),
        // At least one: a subscription to nothing is a webhook that can never
        // fire, and an integrator debugging why would have nowhere to look.
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      validateUrl(input.url);
      const secret = newSecret();
      const inserted = await getDb()
        .insert(webhookSubscriptions)
        .values({
          name: input.name,
          url: input.url,
          secret,
          events: [...new Set(input.events)],
          orgId: stampOrg(ctx.user, null),
        })
        .$returningId();
      return { id: inserted[0].id, secret };
    }),

  update: admin
    .input(
      z.object({
        id: z.number(),
        url: z.string().min(1).max(1000).optional(),
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ownRow(input.id, ctx.user);
      if (input.url !== undefined) validateUrl(input.url);
      const patch: Record<string, unknown> = {};
      if (input.url !== undefined) patch.url = input.url;
      if (input.events !== undefined) patch.events = [...new Set(input.events)];
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (Object.keys(patch).length === 0) return { ok: true };
      await getDb().update(webhookSubscriptions).set(patch).where(eq(webhookSubscriptions.id, input.id));
      return { ok: true };
    }),

  // Rotation exists because the alternative, when a secret leaks, is deleting
  // the subscription and rebuilding it — which loses its delivery history at
  // exactly the moment somebody needs to read it.
  rotateSecret: admin.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    await ownRow(input.id, ctx.user);
    const secret = newSecret();
    await getDb().update(webhookSubscriptions).set({ secret }).where(eq(webhookSubscriptions.id, input.id));
    return { secret };
  }),

  remove: admin.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    await ownRow(input.id, ctx.user);
    const db = getDb();
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, input.id));
    await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, input.id));
    return { ok: true };
  }),

  deliveries: admin
    .input(
      z.object({
        subscriptionId: z.number().optional(),
        status: z.enum(["pending", "delivered", "dead"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const conds = [
        orgWhere(ctx.user, webhookDeliveries.orgId),
        input.subscriptionId ? eq(webhookDeliveries.subscriptionId, input.subscriptionId) : undefined,
        input.status ? eq(webhookDeliveries.status, input.status) : undefined,
      ].filter((c) => c !== undefined);
      return getDb()
        .select({
          id: webhookDeliveries.id,
          subscriptionId: webhookDeliveries.subscriptionId,
          event: webhookDeliveries.event,
          status: webhookDeliveries.status,
          attempts: webhookDeliveries.attempts,
          nextAttemptAt: webhookDeliveries.nextAttemptAt,
          responseStatus: webhookDeliveries.responseStatus,
          lastError: webhookDeliveries.lastError,
          deliveredAt: webhookDeliveries.deliveredAt,
          createdAt: webhookDeliveries.createdAt,
        })
        .from(webhookDeliveries)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(input.limit);
    }),

  // Re-queue a dead delivery. The receiver was fixed; the event they missed is
  // still the one they need, and re-deriving it from the database would give
  // them the world as it looks now rather than as it was.
  redeliver: admin.input(z.object({ ids: z.array(z.number()).min(1).max(100) })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const rows = await db
      .select({ id: webhookDeliveries.id, orgId: webhookDeliveries.orgId })
      .from(webhookDeliveries)
      .where(inArray(webhookDeliveries.id, input.ids));
    for (const r of rows) assertOrgWrite(ctx.user, r.orgId, "Delivery");
    if (rows.length === 0) return { requeued: 0 };
    await db
      .update(webhookDeliveries)
      .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null })
      .where(inArray(webhookDeliveries.id, rows.map((r) => r.id)));
    return { requeued: rows.length };
  }),
});
