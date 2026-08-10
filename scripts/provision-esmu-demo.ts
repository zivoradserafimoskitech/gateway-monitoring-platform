// Provisions the ESMU demo fleet into the DB: 1 stack object (unit 1) + 2 string
// objects (units 2, 3) against the ESMU simulator on port 5022. Idempotent:
// removes prior "ESMU%" rows (incl. ESMU-T e2e rows + their rules/alarms) first.
// Run: npx tsx scripts/provision-esmu-demo.ts
import "dotenv/config";
import { desc, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { meters, gateways, alarmRules, alarms, telemetry } from "../db/schema";

const HOST = "127.0.0.1";
const PORT = 5022;

async function main() {
  const db = getDb();
  const directGw = await db.select().from(gateways).where(eq(gateways.uid, "direct-tcp")).limit(1);
  let gwId = directGw[0]?.id;
  if (!gwId) {
    const ins = await db
      .insert(gateways)
      .values({ uid: "direct-tcp", name: "Direct Modbus TCP (poller)", model: "TCP", transport: "tcp", topicPrefix: "-", status: "online" })
      .$returningId();
    gwId = ins[0].id;
  }

  // Clean prior ESMU rows (demo + e2e) with their telemetry/alarms/rules
  const old = await db.select({ id: meters.id }).from(meters).where(like(meters.name, "ESMU%"));
  const oldIds = old.map((d) => d.id);
  for (let i = 0; i < oldIds.length; i += 500) {
    const chunk = oldIds.slice(i, i + 500);
    await db.delete(telemetry).where(inArray(telemetry.meterId, chunk));
    await db.delete(alarms).where(inArray(alarms.meterId, chunk));
  }
  if (oldIds.length) await db.delete(meters).where(inArray(meters.id, oldIds));
  const oldRules = await db.select({ id: alarmRules.id }).from(alarmRules).where(like(alarmRules.name, "ESMU%"));
  if (oldRules.length) {
    const rids = oldRules.map((r) => r.id);
    await db.delete(alarms).where(inArray(alarms.ruleId, rids));
    await db.delete(alarmRules).where(inArray(alarmRules.id, rids));
  }

  const maxRow = await db
    .select({ modbusAddress: meters.modbusAddress })
    .from(meters)
    .where(eq(meters.gatewayId, gwId))
    .orderBy(desc(meters.modbusAddress))
    .limit(1);
  let slot = (maxRow[0]?.modbusAddress ?? 500) + 1;

  const demo = [
    { unitId: 1, model: "esmu-bams-stack", name: "ESMU Stack-1 (BAMS)" },
    { unitId: 2, model: "esmu-bams-string", name: "ESMU String-1 (ESBCM)" },
    { unitId: 3, model: "esmu-bams-string", name: "ESMU String-2 (ESBCM)" },
  ];
  for (const d of demo) {
    await db.insert(meters).values({
      gatewayId: gwId,
      name: d.name,
      model: d.model,
      deviceType: "bess",
      brand: "ESMU",
      phases: "three",
      modbusAddress: slot++,
      host: HOST,
      port: PORT,
      unitId: d.unitId,
      pollIntervalSec: 15,
      status: "offline",
    });
  }
  console.log(`ESMU demo provisioned: 1 stack + 2 strings on ${HOST}:${PORT} (units 1-3)`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
