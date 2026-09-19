// §9.15: the outbound webhook queue — enqueue, sign, send, retry.
//
// Split deliberately in two. emit() only WRITES a row: it runs on the
// ingestion and control paths, where a slow receiver must never be able to
// hold up an alarm being recorded or a setpoint being written. The sweep does
// all the network work, out of band, under a lease.
import { and, eq, inArray, lte, or, isNull, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { webhookDeliveries, webhookSubscriptions } from "@db/schema";
import type { WebhookSubscription } from "@db/schema";
import { assertEgressAllowed } from "../lib/egress";
import { withLease } from "../lib/leader";
import { signBody } from "./sign";
import { classify, nextAttemptAt, MAX_ATTEMPTS } from "./retry";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  type WebhookEvent,
} from "@contracts/webhook-events";

const SEND_TIMEOUT_MS = 10_000;
const SWEEP_MS = 5_000;
const BATCH = 50;

/** The events column is json; read it defensively — it is user-supplied. */
export function subscribedEvents(sub: { events: unknown }): string[] {
  return Array.isArray(sub.events) ? sub.events.filter((e): e is string => typeof e === "string") : [];
}

/**
 * Queue one event for every subscription that wants it.
 *
 * Tenancy follows notification channels exactly: an event reaches its own
 * org's subscriptions plus any global (NULL-org, superadmin-managed) one.
 *
 * Returns the number of deliveries queued, and never throws — a webhook
 * failing to enqueue must not fail the alarm that caused it.
 */
export async function emit(
  event: WebhookEvent,
  data: Record<string, unknown>,
  orgId: number | null,
): Promise<number> {
  try {
    const db = getDb();
    const orgCond =
      orgId === null
        ? isNull(webhookSubscriptions.orgId)
        : or(eq(webhookSubscriptions.orgId, orgId), isNull(webhookSubscriptions.orgId));
    const subs = await db
      .select()
      .from(webhookSubscriptions)
      .where(and(eq(webhookSubscriptions.enabled, true), orgCond));
    // Matching in JS rather than with JSON_CONTAINS: subscription counts are
    // small, and the predicate then behaves identically on MySQL and TiDB
    // instead of depending on which JSON functions each one implements.
    const wanted = subs.filter((s) => subscribedEvents(s).includes(event));
    if (wanted.length === 0) return 0;
    const at = new Date();
    await db.insert(webhookDeliveries).values(
      wanted.map((s) => ({
        subscriptionId: s.id,
        event,
        // The body is frozen HERE, not rebuilt at send time. A retry must
        // re-send the event as it was: an alarm that has since resolved must
        // not be re-delivered as "raised" carrying a resolved body.
        payload: { event, at: at.toISOString(), data },
        status: "pending" as const,
        nextAttemptAt: at,
        orgId: s.orgId,
      })),
    );
    return wanted.length;
  } catch (e) {
    console.warn("[webhook] enqueue failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

interface AttemptResult {
  status: number | null;
  error: string | null;
}

async function attempt(sub: WebhookSubscription, deliveryId: number, event: string, body: string): Promise<AttemptResult> {
  try {
    // Re-checked at send time, not only when the subscription was saved: a
    // hostname that resolved publicly then can be re-pointed at an internal
    // address afterwards, and this request carries a signature that makes it
    // look authentic to whatever receives it.
    await assertEgressAllowed(sub.url);
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(sub.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signBody(sub.secret, body, ts),
        // Stable across retries, so a receiver can deduplicate. Delivery is
        // at-least-once by construction: a response lost after the receiver
        // committed looks exactly like a failure from here.
        [DELIVERY_HEADER]: String(deliveryId),
        [EVENT_HEADER]: event,
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return { status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function webhookSweep(now: Date = new Date()): Promise<{
  delivered: number;
  retried: number;
  dead: number;
}> {
  const db = getDb();
  const due = await db
    .select({ delivery: webhookDeliveries, sub: webhookSubscriptions })
    .from(webhookDeliveries)
    .innerJoin(webhookSubscriptions, eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id))
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)))
    .limit(BATCH);

  let delivered = 0;
  let retried = 0;
  let dead = 0;
  // A subscription disabled while deliveries were queued: "stop sending me
  // things" is the instruction, so the backlog is closed rather than held to
  // be replayed in a burst whenever somebody re-enables it.
  const disabled = due.filter((r) => !r.sub.enabled).map((r) => r.delivery.id);
  if (disabled.length > 0) {
    await db
      .update(webhookDeliveries)
      .set({ status: "dead", lastError: "subscription disabled" })
      .where(inArray(webhookDeliveries.id, disabled));
    dead += disabled.length;
  }

  for (const { delivery, sub } of due) {
    if (!sub.enabled) continue;
    const body = JSON.stringify({ id: delivery.id, ...(delivery.payload as Record<string, unknown>) });
    const attemptNo = delivery.attempts + 1;
    const r = await attempt(sub, delivery.id, delivery.event, body);
    const outcome = classify(r.status, r.error, attemptNo, MAX_ATTEMPTS);

    if (outcome.kind === "delivered") {
      await db
        .update(webhookDeliveries)
        .set({ status: "delivered", attempts: attemptNo, responseStatus: outcome.status, deliveredAt: new Date(), lastError: null })
        .where(eq(webhookDeliveries.id, delivery.id));
      await db
        .update(webhookSubscriptions)
        .set({ consecutiveFailures: 0, lastSuccessAt: new Date(), lastError: null })
        .where(eq(webhookSubscriptions.id, sub.id));
      delivered++;
      continue;
    }

    const err = outcome.error.slice(0, 500);
    if (outcome.kind === "retry") {
      await db
        .update(webhookDeliveries)
        .set({
          attempts: attemptNo,
          responseStatus: outcome.status,
          lastError: err,
          nextAttemptAt: nextAttemptAt(attemptNo, new Date()),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      retried++;
    } else {
      await db
        .update(webhookDeliveries)
        .set({ status: "dead", attempts: attemptNo, responseStatus: outcome.status, lastError: err })
        .where(eq(webhookDeliveries.id, delivery.id));
      dead++;
    }
    // The counter is on the subscription so a permanently broken endpoint is
    // VISIBLE. It is never used to switch the subscription off: an
    // integration that disables itself is how a customer finds out weeks
    // later that their system stopped receiving alarms.
    await db
      .update(webhookSubscriptions)
      .set({
        consecutiveFailures: sql`${webhookSubscriptions.consecutiveFailures} + 1`,
        lastErrorAt: new Date(),
        lastError: err,
      })
      .where(eq(webhookSubscriptions.id, sub.id));
  }
  return { delivered, retried, dead };
}

let timer: NodeJS.Timeout | null = null;
export function startWebhookLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Leased: two replicas sweeping the same queue would deliver every event
    // twice, and the signature would make both copies look genuine.
    withLease("webhook-dispatch", () => webhookSweep()).catch((e) =>
      console.warn("[webhook] sweep failed:", e instanceof Error ? e.message : e),
    );
  }, SWEEP_MS);
  timer.unref?.();
  console.log("[webhook] dispatcher started");
}
