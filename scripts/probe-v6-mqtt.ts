// v6/B5 probe: PV inverter + BESS reporting over MQTT JSON uplink (G30 path).
// Publishes profile open keys (dcPowerKw, socPercent, batteryPowerKw...) which
// were silently dropped before R8. Verifies auto-provisioning (R10) and
// persistence, then cleans up.
import "dotenv/config";
import mqtt from "mqtt";
import { getDb } from "../api/queries/connection";
import { gateways, meters } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { getTelemetryStore } from "../api/telemetry";

const GW_UID = "gw-mqtt-pv";
const url = process.env.MQTT_URL ?? "mqtt://localhost:1883";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const db = getDb();
  const gw = await db.select().from(gateways).where(eq(gateways.uid, GW_UID)).limit(1);
  if (!gw[0]) throw new Error("probe gateway missing — create it first");
  const topic = `${gw[0].topicPrefix}/${GW_UID}`;

  const client = mqtt.connect(url, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  });
  await new Promise<void>((res, rej) => {
    client.on("connect", () => res());
    client.on("error", rej);
  });

  const inverter = {
    addr: 5,
    model: "huawei-sun2000",
    data: {
      dcPowerKw: 42.3, // hint kW → unconverted
      activePowerKw: 38.7,
      energyTotalKwh: 15234.2,
      energyTodayKwh: 210.5,
      internalTempC: 41.2,
      voltageL1: 231.4,
      rogueKey: 999, // not in profile → must be dropped
    },
  };
  const bess = {
    addr: 6,
    model: "victron-gx",
    data: {
      socPercent: 87.5,
      batteryPowerKw: 2600, // hint W → 2.6 kW after open-key conversion
      chargeEnergyTotalKwh: 987.6,
      dischargeEnergyTotalKwh: 654.3,
      batteryVoltageV: 52.1,
    },
  };
  const unknown = { addr: 7, model: "no-such-model", data: { P: 100 } };

  client.publish(topic, JSON.stringify([inverter, bess, unknown]), { qos: 1 });
  await sleep(4000); // ingestion + batch flush
  client.end();

  const rows = await db
    .select()
    .from(meters)
    .where(eq(meters.gatewayId, gw[0].id));
  const byAddr = new Map(rows.map((m) => [m.modbusAddress, m]));
  let fails = 0;
  const check = (name: string, cond: boolean, detail: unknown) => {
    console.log(cond ? "PASS" : "FAIL", name, "->", JSON.stringify(detail).slice(0, 200));
    if (!cond) fails++;
  };

  const inv = byAddr.get(5);
  check("inverter auto-provisioned w/ profile type+brand",
    !!inv && inv.model === "huawei-sun2000" && inv.deviceType === "inverter" && inv.brand != null,
    inv && { model: inv.model, deviceType: inv.deviceType, brand: inv.brand });

  const bessM = byAddr.get(6);
  check("bess auto-provisioned w/ profile type", !!bessM && bessM.deviceType === "bess",
    bessM && { model: bessM.model, deviceType: bessM.deviceType });

  const unk = byAddr.get(7);
  check("unknown model falls back to PEM3000", !!unk && unk.model === "PEM3000" && unk.deviceType === "meter",
    unk && { model: unk.model, deviceType: unk.deviceType });

  const store = getTelemetryStore();
  if (inv) {
    const latest = await store.latest(inv.id);
    const v = latest?.values ?? {};
    check("inverter open keys persisted",
      v.dcPowerKw === 42.3 && v.energyTotalKwh === 15234.2 && v.energyTodayKwh === 210.5 &&
      v.internalTempC === 41.2 && v.activePowerKw === 38.7, v);
    check("rogue key dropped", !("rogueKey" in v), Object.keys(v));
  }
  if (bessM) {
    const latest = await store.latest(bessM.id);
    const v = latest?.values ?? {};
    check("bess open keys persisted + W→kW conversion",
      v.socPercent === 87.5 && v.batteryPowerKw === 2.6 && v.chargeEnergyTotalKwh === 987.6 &&
      v.dischargeEnergyTotalKwh === 654.3 && v.batteryVoltageV === 52.1, v);
  }

  // cleanup: remove probe meters (cascades telemetry) — gateway removed by caller
  if (rows.length) {
    const { telemetry, alarms } = await import("../db/schema");
    await db.delete(telemetry).where(inArray(telemetry.meterId, rows.map((m) => m.id)));
    await db.delete(alarms).where(inArray(alarms.meterId, rows.map((m) => m.id)));
    await db.delete(meters).where(eq(meters.gatewayId, gw[0].id));
  }
  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
