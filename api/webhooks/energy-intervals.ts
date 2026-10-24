// energy.interval.closed: push each closed 15-minute energy interval to the
// orgs that subscribed, so VoltTrade settles from gateway data without polling
// GET /devices/:id/energy. Only orgs with an enabled subscription to the event
// are walked; the data comes from the same telemetry store as the REST route.
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { meters, webhookSubscriptions } from "@db/schema";
import { getTelemetryStore } from "../telemetry";
import { withLease } from "../lib/leader";
import { emit, subscribedEvents } from "./dispatch";

export const INTERVAL_MIN = 15;
const INTERVAL_MS = INTERVAL_MIN * 60_000;
/** Wait this long after a boundary so late telemetry is in. */
const SETTLE_MS = 2 * 60_000;

/** The most recent interval that is closed and settled at `nowMs`. */
export function lastClosedInterval(nowMs: number): { from: Date; to: Date } {
  const end = Math.floor((nowMs - SETTLE_MS) / INTERVAL_MS) * INTERVAL_MS;
  return { from: new Date(end - INTERVAL_MS), to: new Date(end) };
}

let lastEmittedEnd = 0;

export async function energyIntervalSweep(now = new Date()): Promise<number> {
  const { from, to } = lastClosedInterval(now.getTime());
  if (to.getTime() <= lastEmittedEnd) return 0;
  lastEmittedEnd = to.getTime();
  const db = getDb();
  const subs = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.enabled, true));
  const wanting = subs.filter((s) => subscribedEvents(s).includes("energy.interval.closed"));
  if (wanting.length === 0) return 0;
  const global = wanting.some((s) => s.orgId === null);
  const orgIds = [...new Set(wanting.map((s) => s.orgId).filter((o): o is number => o !== null))];
  const devs = await db
    .select({ id: meters.id, orgId: meters.orgId })
    .from(meters)
    .where(global ? undefined : inArray(meters.orgId, orgIds));
  let n = 0;
  for (const d of devs) {
    const buckets = await getTelemetryStore().energyIntervals(d.id, from, to, INTERVAL_MIN);
    const b = buckets[0];
    if (!b) continue;
    await emit("energy.interval.closed", { meterId: d.id, from: from.toISOString(), to: to.toISOString(), bucketMin: INTERVAL_MIN, ...b }, d.orgId ?? null);
    n++;
  }
  return n;
}

let timer: NodeJS.Timeout | null = null;
export function startEnergyIntervalLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    withLease("energy-interval-webhooks", () => energyIntervalSweep(), 5 * 60_000).catch((e) =>
      console.warn("[webhook] energy interval sweep failed:", e instanceof Error ? e.message : e),
    );
  }, 60_000);
  timer.unref?.();
}

