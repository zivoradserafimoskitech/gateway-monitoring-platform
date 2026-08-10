// Removes the scale PV fleet provisioned by provision-pv-scale.ts:
// all "SCL %" meters under the direct-tcp gateway (+ their telemetry/alarms)
// and all "SCL %" alarm rules (+ their alarms). Original demo devices untouched.
// Run: npx tsx scripts/cleanup-pv-scale.ts
import "dotenv/config";
import { assertDestructiveOk } from "./lib/db-guard";
import { and, eq, like, inArray } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { meters, gateways, alarmRules, alarms, telemetry } from "../db/schema";

async function main() {
  assertDestructiveOk("cleanup-pv-scale");
  const db = getDb();
  const directGw = await db.select().from(gateways).where(eq(gateways.uid, "direct-tcp")).limit(1);
  const gwId = directGw[0]?.id;

  let removedDevices = 0;
  if (gwId) {
    const scl = await db
      .select({ id: meters.id })
      .from(meters)
      .where(and(eq(meters.gatewayId, gwId), like(meters.name, "SCL %")));
    const ids = scl.map((d) => d.id);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await db.delete(telemetry).where(inArray(telemetry.meterId, chunk));
      await db.delete(alarms).where(inArray(alarms.meterId, chunk));
    }
    if (ids.length) await db.delete(meters).where(inArray(meters.id, ids));
    removedDevices = ids.length;
  }

  const sclRules = await db.select({ id: alarmRules.id }).from(alarmRules).where(like(alarmRules.name, "SCL %"));
  const ruleIds = sclRules.map((r) => r.id);
  if (ruleIds.length) {
    await db.delete(alarms).where(inArray(alarms.ruleId, ruleIds));
    await db.delete(alarmRules).where(inArray(alarmRules.id, ruleIds));
  }

  console.log(`cleanup-pv-scale: removed ${removedDevices} SCL devices, ${ruleIds.length} SCL rules (+telemetry/alarms)`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
