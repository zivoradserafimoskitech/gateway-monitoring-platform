// Repairs referential-integrity damage found in the v4 engineering review:
//  1. telemetry rows whose meter_id points at a deleted meter (orphans)
//  2. alarms rows whose meter_id points at a deleted meter
//  3. alarms rows whose rule_id points at a deleted alarm rule
//  4. stray auto-provisioned gateway uid='test' (if it has no meters)
// Deletes are chunked to avoid giant IN() lists / long transactions.
// Run: npx tsx scripts/repair-orphans.ts
import "dotenv/config";
import { assertDestructiveOk } from "./lib/db-guard";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { meters, gateways, alarmRules, alarms, telemetry } from "../db/schema";

const CHUNK = 500;

async function chunkedDeleteByIds(
  table: "telemetry" | "alarms",
  ids: number[]
): Promise<number> {
  if (!ids.length) return 0;
  const db = getDb();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if (table === "telemetry") {
      await db.delete(telemetry).where(inArray(telemetry.id, chunk));
    } else {
      await db.delete(alarms).where(inArray(alarms.id, chunk));
    }
  }
  return ids.length;
}

async function main() {
  assertDestructiveOk("repair-orphans");
  const db = getDb();
  const report: Record<string, number | string> = {};

  // ── 1. Orphan telemetry (dead meter_id) ─────────────────────────────────
  const orphanTelemetry = await db
    .select({ id: telemetry.id })
    .from(telemetry)
    .leftJoin(meters, eq(telemetry.meterId, meters.id))
    .where(sql`${meters.id} IS NULL`);
  report.telemetryOrphansRemoved = await chunkedDeleteByIds(
    "telemetry",
    orphanTelemetry.map((r) => r.id)
  );

  // ── 2. Orphan alarms (dead meter_id) ────────────────────────────────────
  const orphanAlarmsByMeter = await db
    .select({ id: alarms.id })
    .from(alarms)
    .leftJoin(meters, eq(alarms.meterId, meters.id))
    .where(sql`${meters.id} IS NULL`);
  report.alarmOrphansByMeterRemoved = await chunkedDeleteByIds(
    "alarms",
    orphanAlarmsByMeter.map((r) => r.id)
  );

  // ── 3. Orphan alarms (dead rule_id) ─────────────────────────────────────
  const orphanAlarmsByRule = await db
    .select({ id: alarms.id })
    .from(alarms)
    .leftJoin(alarmRules, eq(alarms.ruleId, alarmRules.id))
    .where(sql`${alarmRules.id} IS NULL`);
  report.alarmOrphansByRuleRemoved = await chunkedDeleteByIds(
    "alarms",
    orphanAlarmsByRule.map((r) => r.id)
  );

  // ── 4. Stray auto-provisioned gateway uid='test' (only if it owns nothing) ──
  const stray = await db.select().from(gateways).where(sql`${gateways.uid} = 'test'`).limit(1);
  if (stray[0]) {
    const owned = await db
      .select({ id: meters.id })
      .from(meters)
      .where(sql`${meters.gatewayId} = ${stray[0].id}`)
      .limit(1);
    if (owned.length === 0) {
      await db.delete(gateways).where(sql`${gateways.id} = ${stray[0].id}`);
      report.strayTestGatewayRemoved = 1;
    } else {
      report.strayTestGatewayRemoved = "skipped (has meters)";
    }
  } else {
    report.strayTestGatewayRemoved = "not present";
  }

  // ── Verification: counts must now be zero ───────────────────────────────
  const remainingT = await db
    .select({ n: sql<number>`count(*)` })
    .from(telemetry)
    .leftJoin(meters, eq(telemetry.meterId, meters.id))
    .where(sql`${meters.id} IS NULL`);
  const remainingA = await db
    .select({ n: sql<number>`count(*)` })
    .from(alarms)
    .leftJoin(meters, eq(alarms.meterId, meters.id))
    .where(sql`${meters.id} IS NULL`);
  report.remainingTelemetryOrphans = Number(remainingT[0].n);
  report.remainingAlarmOrphans = Number(remainingA[0].n);

  console.log("repair-orphans report:", JSON.stringify(report, null, 2));
  if (report.remainingTelemetryOrphans !== 0 || report.remainingAlarmOrphans !== 0) {
    console.error("repair-orphans: orphans remain after repair!");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
