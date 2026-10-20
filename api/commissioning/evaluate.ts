// §9.10: gather the facts the commissioning checklist is evaluated from.
//
// The judgements live in contracts/commissioning.ts and are pure. This file
// only answers questions about the database, which is the half that cannot be
// unit-tested without one — keeping them apart is what makes the checklist's
// rules testable at all.
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  alarmRules,
  batteryHealth,
  commands,
  commissioningSignoffs,
  deviceProfiles,
  gateways,
  meters,
  notificationChannels,
  sites,
} from "@db/schema";
import { evaluateChecklist, type SiteFacts, type StepResult } from "@contracts/commissioning";

/**
 * How recently a device must have reported to count as "flowing".
 *
 * Fifteen minutes rather than "ever": a device that spoke once during the
 * install and has been silent since is exactly the failure commissioning is
 * supposed to catch before anybody drives away.
 */
const FRESH_MS = 15 * 60_000;

export async function siteFacts(siteId: number): Promise<SiteFacts | null> {
  const db = getDb();
  const siteRows = await db
    .select({ id: sites.id, name: sites.name, timezone: sites.timezone, orgId: sites.orgId })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  const site = siteRows[0];
  if (!site) return null;

  const gatewayRows = await db
    .select({ id: gateways.id, status: gateways.status, lastSeenAt: gateways.lastSeenAt })
    .from(gateways)
    .where(eq(gateways.siteId, siteId));
  const gatewayIds = gatewayRows.map((g) => g.id);
  const freshCutoff = new Date(Date.now() - FRESH_MS);
  const gatewaysOnline = gatewayRows.filter(
    (g) => g.status === "online" && g.lastSeenAt !== null && g.lastSeenAt >= freshCutoff,
  ).length;

  // Effective site, the same rule as everywhere else (v6/R7): a device's own
  // binding, else its gateway's. A commissioning view that only counted
  // directly-bound devices would report an empty site for every ordinary
  // installation, where devices inherit the gateway's site.
  const deviceRows = gatewayIds.length
    ? await db
        .select({ id: meters.id, model: meters.model, deviceType: meters.deviceType, lastSeenAt: meters.lastSeenAt })
        .from(meters)
        .where(or(eq(meters.siteId, siteId), inArray(meters.gatewayId, gatewayIds)))
    : await db
        .select({ id: meters.id, model: meters.model, deviceType: meters.deviceType, lastSeenAt: meters.lastSeenAt })
        .from(meters)
        .where(eq(meters.siteId, siteId));
  const deviceIds = deviceRows.map((d) => d.id);
  const devicesReporting = deviceRows.filter((d) => d.lastSeenAt !== null && d.lastSeenAt >= freshCutoff).length;

  // Profile verification state per distinct model, then counted per device.
  const models = [...new Set(deviceRows.map((d) => d.model))];
  const profileRows = models.length
    ? await db
        .select({ model: deviceProfiles.model, verificationStatus: deviceProfiles.verificationStatus })
        .from(deviceProfiles)
        .where(inArray(deviceProfiles.model, models))
    : [];
  const byModel = new Map(profileRows.map((p) => [p.model, p.verificationStatus]));
  let devicesWithDraftProfile = 0;
  let devicesWithoutProfile = 0;
  for (const d of deviceRows) {
    const v = byModel.get(d.model);
    if (v === undefined) devicesWithoutProfile++;
    else if (v === "draft") devicesWithDraftProfile++;
  }

  // Rules that cover this site: one bound to a device here, or a fleet-wide
  // rule (null meterId), which covers every device including these.
  const ruleRows = await db
    .select({ id: alarmRules.id, meterId: alarmRules.meterId })
    .from(alarmRules)
    .where(
      and(
        eq(alarmRules.enabled, true),
        deviceIds.length ? or(isNull(alarmRules.meterId), inArray(alarmRules.meterId, deviceIds)) : isNull(alarmRules.meterId),
      ),
    );

  const channelRows = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.enabled, 1),
        site.orgId === null
          ? isNull(notificationChannels.orgId)
          : or(eq(notificationChannels.orgId, site.orgId), isNull(notificationChannels.orgId)),
      ),
    );

  const bess = deviceRows.filter((d) => d.deviceType === "bess");
  const nameplateRows = bess.length
    ? await db
        .select({ meterId: batteryHealth.meterId, nameplateKwh: batteryHealth.nameplateKwh })
        .from(batteryHealth)
        .where(
          inArray(
            batteryHealth.meterId,
            bess.map((b) => b.id),
          ),
        )
    : [];
  const bessWithNameplate = nameplateRows.filter((r) => r.nameplateKwh !== null).length;

  // Evidence of control, not a rehearsal: a dry run deliberately writes no
  // commands row, so it cannot satisfy this step.
  const provenRows = deviceIds.length
    ? await db
        .select({ n: sql<number>`count(*)` })
        .from(commands)
        .where(and(eq(commands.kind, "control"), eq(commands.status, "ok"), inArray(commands.meterId, deviceIds)))
    : [];
  const provenControlWrites = Number(provenRows[0]?.n ?? 0);

  const signoff = await db
    .select({ signedByName: commissioningSignoffs.signedByName, note: commissioningSignoffs.note })
    .from(commissioningSignoffs)
    .where(eq(commissioningSignoffs.siteId, siteId))
    .limit(1);

  return {
    siteName: site.name,
    hasTimezone: Boolean(site.timezone && site.timezone.trim().length > 0),
    gatewayCount: gatewayRows.length,
    gatewaysOnline,
    deviceCount: deviceRows.length,
    devicesReporting,
    devicesWithDraftProfile,
    devicesWithoutProfile,
    enabledRulesCovering: ruleRows.length,
    enabledChannels: channelRows.length,
    bessCount: bess.length,
    bessWithNameplate,
    provenControlWrites,
    handoverSignedBy: signoff[0]?.signedByName ?? null,
    handoverNote: signoff[0]?.note ?? null,
  };
}

export async function siteChecklist(siteId: number): Promise<{ facts: SiteFacts; steps: StepResult[] } | null> {
  const facts = await siteFacts(siteId);
  if (!facts) return null;
  return { facts, steps: evaluateChecklist(facts) };
}

/** Exposed so a screen can say what "reporting" means rather than implying a
 *  freshness window the reader has to guess at. */
export const FRESHNESS_MS = FRESH_MS;
