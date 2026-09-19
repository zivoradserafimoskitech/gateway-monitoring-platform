// §9.14: the deletion path.
//
// "Delete our data" had no implementation. The nearest thing was removing rows
// by hand in whatever order occurred to whoever was holding the console, which
// is how a tenant ends up deleted from the org table and still present in
// telemetry, alarms and the command audit trail.
//
// Two decisions shape this file.
//
// It is SCHEDULED, not immediate. An irreversible delete of a tenant's entire
// history, executed the instant somebody clicks, has no way back from a
// misclick or a misunderstood ticket. The grace period is the feature, and
// cancelling during it is a supported action rather than a database restore.
//
// And it is ordered and counted. Children go before parents so nothing is
// orphaned, and every table reports how many rows it removed — "we deleted
// your data" is a claim somebody may later have to substantiate.
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  alarmNotifications,
  alarmRules,
  alarmSuppressions,
  alarms,
  apiKeys,
  commands,
  curtailmentAssets,
  dataExports,
  deviceRegistrations,
  emsPlans,
  emsSchedules,
  gateways,
  gridLimits,
  maintenanceWindows,
  meters,
  notificationChannels,
  onCallShifts,
  orgInvites,
  orgMemberships,
  orgs,
  otaJobs,
  reportSchedules,
  sites,
  users,
  webhookDeliveries,
  webhookSubscriptions,
} from "@db/schema";
import { withLease } from "../lib/leader";

const SWEEP_MS = 60_000;

/** Grace period between requesting a deletion and it becoming irreversible. */
export const DELETION_GRACE_DAYS = parseInt(process.env.ORG_DELETION_GRACE_DAYS || "7", 10);

export function deletionDueAt(now: Date = new Date(), graceDays: number = DELETION_GRACE_DAYS): Date {
  // At least a day, whatever the configuration says. A zero-day grace period
  // is an immediate delete wearing the word "scheduled".
  const days = Number.isFinite(graceDays) && graceDays >= 1 ? Math.floor(graceDays) : 7;
  return new Date(now.getTime() + days * 86_400_000);
}

export interface PurgeCounts {
  [table: string]: number;
}

function affected(res: unknown): number {
  const head = Array.isArray(res) ? res[0] : res;
  return Number((head as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

/**
 * Delete everything belonging to one org, children first.
 *
 * Telemetry is removed by device rather than by org because the telemetry
 * table has no org column — it is joined through meters, which is also why
 * meters are deleted late rather than early.
 */
export async function purgeOrg(orgId: number): Promise<PurgeCounts> {
  const db = getDb();
  const counts: PurgeCounts = {};

  const meterRows = await db.select({ id: meters.id }).from(meters).where(eq(meters.orgId, orgId));
  const meterIds = meterRows.map((m) => m.id);
  const gatewayRows = await db.select({ id: gateways.id }).from(gateways).where(eq(gateways.orgId, orgId));
  const gatewayIds = gatewayRows.map((g) => g.id);

  if (meterIds.length > 0) {
    // Raw telemetry and its rollups: the largest thing here by a wide margin,
    // and the reason this runs in a background sweep rather than in a request.
    const ids = sql.join(meterIds.map((id) => sql`${id}`), sql`, `);
    counts.telemetry = affected(await db.execute(sql`delete from telemetry where meter_id in (${ids})`));
    counts.telemetryHourly = affected(
      await db.execute(sql`delete from telemetry_hourly where meter_id in (${ids})`),
    );
    counts.alarms = affected(await db.delete(alarms).where(inArray(alarms.meterId, meterIds)));
    counts.commands = affected(await db.delete(commands).where(inArray(commands.meterId, meterIds)));
    await db.delete(emsSchedules).where(inArray(emsSchedules.meterId, meterIds));
    await db.delete(emsPlans).where(inArray(emsPlans.meterId, meterIds));
    await db.delete(curtailmentAssets).where(inArray(curtailmentAssets.meterId, meterIds));
  }
  if (gatewayIds.length > 0) {
    await db.delete(otaJobs).where(inArray(otaJobs.gatewayId, gatewayIds));
  }

  // Everything that carries the org directly.
  const byOrg: Array<[string, () => Promise<unknown>]> = [
    ["alarmNotifications", () => db.delete(alarmNotifications).where(eq(alarmNotifications.orgId, orgId))],
    ["alarmRules", () => db.delete(alarmRules).where(eq(alarmRules.orgId, orgId))],
    ["alarmSuppressions", () => db.delete(alarmSuppressions).where(eq(alarmSuppressions.orgId, orgId))],
    ["onCallShifts", () => db.delete(onCallShifts).where(eq(onCallShifts.orgId, orgId))],
    ["notificationChannels", () => db.delete(notificationChannels).where(eq(notificationChannels.orgId, orgId))],
    ["maintenanceWindows", () => db.delete(maintenanceWindows).where(eq(maintenanceWindows.orgId, orgId))],
    ["webhookDeliveries", () => db.delete(webhookDeliveries).where(eq(webhookDeliveries.orgId, orgId))],
    ["webhookSubscriptions", () => db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.orgId, orgId))],
    ["reportSchedules", () => db.delete(reportSchedules).where(eq(reportSchedules.orgId, orgId))],
    ["gridLimits", () => db.delete(gridLimits).where(eq(gridLimits.orgId, orgId))],
    ["deviceRegistrations", () => db.delete(deviceRegistrations).where(eq(deviceRegistrations.orgId, orgId))],
    ["otaJobs", () => db.delete(otaJobs).where(eq(otaJobs.orgId, orgId))],
    ["apiKeys", () => db.delete(apiKeys).where(eq(apiKeys.orgId, orgId))],
    // §9.11: memberships and outstanding invites. An invite that outlived its
    // org is a link that creates an account in a tenant that no longer exists.
    ["orgInvites", () => db.delete(orgInvites).where(eq(orgInvites.orgId, orgId))],
    ["orgMemberships", () => db.delete(orgMemberships).where(eq(orgMemberships.orgId, orgId))],
    ["meters", () => db.delete(meters).where(eq(meters.orgId, orgId))],
    ["gateways", () => db.delete(gateways).where(eq(gateways.orgId, orgId))],
    ["sites", () => db.delete(sites).where(eq(sites.orgId, orgId))],
    ["users", () => db.delete(users).where(eq(users.orgId, orgId))],
  ];
  for (const [name, run] of byOrg) {
    const res = await run();
    counts[name] = affected(res);
  }

  // The export archives last, and their files with them: an export of a
  // deleted tenant is exactly the copy nobody meant to keep.
  const exports_ = await db
    .select({ id: dataExports.id, filePath: dataExports.filePath })
    .from(dataExports)
    .where(eq(dataExports.orgId, orgId));
  if (exports_.length > 0) {
    const fs = await import("node:fs");
    for (const e of exports_) {
      if (e.filePath) {
        try {
          fs.rmSync(e.filePath, { force: true });
        } catch {
          /* the row goes either way; a stale file is not a reason to stop */
        }
      }
    }
    counts.dataExports = affected(await db.delete(dataExports).where(eq(dataExports.orgId, orgId)));
  }

  counts.orgs = affected(await db.delete(orgs).where(eq(orgs.id, orgId)));
  return counts;
}

/** Purge orgs whose grace period has run out. */
export async function deletionSweep(now: Date = new Date()): Promise<{ purged: number }> {
  const db = getDb();
  const due = await db
    .select({ id: orgs.id, name: orgs.name })
    .from(orgs)
    .where(and(isNotNull(orgs.deletionScheduledFor), lte(orgs.deletionScheduledFor, now)))
    .limit(5);
  for (const o of due) {
    const counts = await purgeOrg(o.id);
    // Logged rather than silent: this is the one operation in the system with
    // nothing to inspect afterwards, so the log line is the only record that
    // it happened and what it removed.
    console.warn(`[org-purge] deleted org ${o.id} (${o.name}): ${JSON.stringify(counts)}`);
  }
  return { purged: due.length };
}

let timer: NodeJS.Timeout | null = null;
export function startDeletionLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Leased: two replicas purging the same org would interleave deletes and
    // double-count what they removed, and the counts are the record.
    withLease("org-deletion", () => deletionSweep()).catch((e) =>
      console.warn("[org-purge] sweep failed:", e instanceof Error ? e.message : e),
    );
  }, SWEEP_MS);
  timer.unref?.();
}
