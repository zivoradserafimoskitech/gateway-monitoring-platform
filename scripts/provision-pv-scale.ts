// Provisions the scale PV fleet into the DB, mirroring the multi-plant
// simulator's layout file (/tmp/pv-scale-layout.json):
//   30 plants × 3 inverters + 20 BESS = 110 direct-TCP devices, prefix "SCL ".
// Also creates one low-SOC alarm rule per scale BESS (S5) — prefix "SCL ".
// Idempotent: existing "SCL %" devices/rules/alarms are removed first.
// Run: npx tsx scripts/provision-pv-scale.ts [layoutPath]
import "dotenv/config";
import { readFileSync } from "node:fs";
import { and, desc, eq, like, inArray } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { meters, gateways, alarmRules, alarms } from "../db/schema";
import { DEVICE_PROFILE_LIBRARY } from "../db/device-profile-library";

const HOST = "127.0.0.1";
const LAYOUT = process.argv[2] ?? "/tmp/pv-scale-layout.json";

interface LayoutUnit { unitId: number; model: string; deviceType: string }
interface LayoutPlant { port: number; units: LayoutUnit[] }

async function main() {
  const db = getDb();
  const layout = JSON.parse(readFileSync(LAYOUT, "utf8")) as LayoutPlant[];

  const directGw = await db.select().from(gateways).where(eq(gateways.uid, "direct-tcp")).limit(1);
  let gwId = directGw[0]?.id;
  if (!gwId) {
    const ins = await db
      .insert(gateways)
      .values({ uid: "direct-tcp", name: "Direct Modbus TCP (poller)", model: "TCP", transport: "tcp", topicPrefix: "-", status: "online" })
      .$returningId();
    gwId = ins[0].id;
  }

  // Clean previous scale fleet (devices → their telemetry/alarms; rules → alarms)
  const oldDevs = await db.select({ id: meters.id }).from(meters).where(and(eq(meters.gatewayId, gwId), like(meters.name, "SCL %")));
  const oldIds = oldDevs.map((d) => d.id);
  if (oldIds.length) {
    const { telemetry } = await import("../db/schema");
    for (let i = 0; i < oldIds.length; i += 500) {
      const chunk = oldIds.slice(i, i + 500);
      await db.delete(telemetry).where(inArray(telemetry.meterId, chunk));
      await db.delete(alarms).where(inArray(alarms.meterId, chunk));
    }
    await db.delete(meters).where(inArray(meters.id, oldIds));
  }
  const oldRules = await db.select({ id: alarmRules.id }).from(alarmRules).where(like(alarmRules.name, "SCL %"));
  if (oldRules.length) {
    await db.delete(alarms).where(inArray(alarms.ruleId, oldRules.map((r) => r.id)));
    await db.delete(alarmRules).where(inArray(alarmRules.id, oldRules.map((r) => r.id)));
  }

  // Next free synthetic modbusAddress slot under the direct-tcp gateway
  const maxRow = await db
    .select({ modbusAddress: meters.modbusAddress })
    .from(meters)
    .where(eq(meters.gatewayId, gwId))
    .orderBy(desc(meters.modbusAddress))
    .limit(1);
  let slot = (maxRow[0]?.modbusAddress ?? 500) + 1;

  const meta = new Map(DEVICE_PROFILE_LIBRARY.map((p) => [p.model, p]));
  let inv = 0;
  let bess = 0;
  const bessMeterIds: number[] = [];
  for (const plant of layout) {
    for (const u of plant.units) {
      const p = meta.get(u.model);
      if (!p) throw new Error(`profile ${u.model} missing`);
      const ins = await db.insert(meters).values({
        gatewayId: gwId,
        name: `SCL P${plant.port} ${p.brand} ${u.deviceType === "inverter" ? "INV" : "BESS"}-${u.unitId}`,
        model: p.model,
        deviceType: p.deviceType,
        brand: p.brand,
        phases: "three",
        modbusAddress: slot++,
        host: HOST,
        port: plant.port,
        unitId: u.unitId,
        pollIntervalSec: 15,
        status: "offline",
      }).$returningId();
      if (u.deviceType === "inverter") inv++;
      else {
        bess++;
        bessMeterIds.push(ins[0].id);
      }
    }
  }

  // S5: one low-SOC rule per scale BESS (fires for SOC < 70)
  for (const id of bessMeterIds) {
    await db.insert(alarmRules).values({
      name: `SCL low SOC (meter ${id})`,
      metric: "socPercent",
      operator: "lt",
      threshold: 70,
      severity: "warning",
      meterId: id,
    });
  }

  console.log(`scale fleet provisioned: ${inv} inverters + ${bess} BESS across ${layout.length} plants; ${bessMeterIds.length} SOC rules`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
