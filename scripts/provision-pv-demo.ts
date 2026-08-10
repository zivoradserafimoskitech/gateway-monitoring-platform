// Provisions the demo PV plant: direct-TCP devices matching the standalone
// device-simulator daemon (port 5021, --inverters 6 --bess 2) and removes
// e2e-test artifacts (rules/alarms) for a clean demo state.
// Run: npx tsx scripts/provision-pv-demo.ts
import "dotenv/config";
import { and, eq, like, inArray } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { meters, gateways, alarmRules, alarms } from "../db/schema";
import { DEVICE_PROFILE_LIBRARY } from "../db/device-profile-library";

const PORT = 5021;
const HOST = "127.0.0.1";

// Must mirror the simulator daemon log: pool order = library order.
const DEMO: Array<{ unitId: number; model: string }> = [
  { unitId: 1, model: "huawei-sun2000" },
  { unitId: 2, model: "sungrow-sg-sh" },
  { unitId: 3, model: "sma-sunspec" },
  { unitId: 4, model: "fronius-sunspec" },
  { unitId: 5, model: "solaredge-sunspec" },
  { unitId: 6, model: "growatt-mod-mid" },
  { unitId: 7, model: "victron-gx" },
  { unitId: 8, model: "pylontech-bess" },
];

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

  // Remove previous direct-TCP demo/e2e devices on this host
  await db.delete(meters).where(and(eq(meters.gatewayId, gwId), eq(meters.host, HOST)));

  // Remove e2e alarm artifacts
  const e2eRules = await db.select({ id: alarmRules.id }).from(alarmRules).where(like(alarmRules.name, "E2E %"));
  if (e2eRules.length) {
    await db.delete(alarms).where(inArray(alarms.ruleId, e2eRules.map((r) => r.id)));
    await db.delete(alarmRules).where(inArray(alarmRules.id, e2eRules.map((r) => r.id)));
  }

  const meta = new Map(DEVICE_PROFILE_LIBRARY.map((p) => [p.model, p]));
  const slotBase = 500;
  for (const d of DEMO) {
    const p = meta.get(d.model);
    if (!p) throw new Error(`profile ${d.model} missing`);
    await db.insert(meters).values({
      gatewayId: gwId,
      name: `${p.brand} ${p.deviceType === "inverter" ? "INV" : "BESS"}-${d.unitId}`,
      model: p.model,
      deviceType: p.deviceType,
      brand: p.brand,
      phases: "three",
      modbusAddress: slotBase + d.unitId,
      host: HOST,
      port: PORT,
      unitId: d.unitId,
      pollIntervalSec: 10,
      status: "offline",
    });
  }
  console.log(`demo PV plant provisioned: ${DEMO.length} devices on ${HOST}:${PORT} (e2e artifacts cleaned: ${e2eRules.length} rules)`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
