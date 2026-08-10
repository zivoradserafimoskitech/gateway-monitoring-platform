// v6/B6 probe: C30 transparent frame from a multi-unit device on an RS-485
// bus — ESMU string at bus address 3 → register block shifted to
// base + (3-2)×3000 = 3100. Before R9 the C30 path decoded against the raw
// map (base 100) and could never decode bus units > firstUnit.
// Creates a temporary C30 gateway + bus meter, feeds a crafted FC4 frame,
// verifies persistence, cleans up.
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { gateways, meters, telemetry, alarms } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { handleC30Frame, clearMeterCache } from "../api/mqtt/handlers";
import { crc16 } from "../api/modbus";
import { getTelemetryWriter } from "../api/telemetry";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildFc4Response(slave: number, regs: number[]): Buffer {
  const frame = Buffer.alloc(3 + regs.length * 2 + 2);
  frame[0] = slave;
  frame[1] = 4;
  frame[2] = regs.length * 2;
  regs.forEach((v, i) => frame.writeUInt16BE(v & 0xffff, 3 + i * 2));
  const crc = crc16(frame.subarray(0, frame.length - 2));
  frame.writeUInt16LE(crc, frame.length - 2);
  return frame;
}

async function main() {
  const db = getDb();
  const gwId = await db
    .insert(gateways)
    .values({ uid: "gw-c30-esmu", name: "V6 C30 stride probe", model: "C30", transport: "transparent", topicPrefix: "d2g" })
    .$returningId();
  const meterId = await db
    .insert(meters)
    .values({
      gatewayId: gwId[0].id,
      name: "ESBCM bus unit 3 (probe)",
      model: "esmu-bams-string",
      deviceType: "bess",
      brand: "ESMU",
      modbusAddress: 3,
      status: "online",
    })
    .$returningId();
  const mid = meterId[0].id;

  try {
    const gw = await db.select().from(gateways).where(eq(gateways.id, gwId[0].id)).limit(1);
    // esmu-bams-string defs start at 100 with stride {firstUnit:2, stride:3000}
    // → bus unit 3 block starts at 3100. Sentinel values the world never produces.
    const regs = [9, 999, 998, 511, 513];
    const frame = buildFc4Response(3, regs);
    const result = await handleC30Frame(gw[0], frame);
    console.log("decode result:", JSON.stringify(result));

    await sleep(3000); // writer flush is 1 s
    console.log("writer stats:", JSON.stringify(getTelemetryWriter().stats));
    const rows = await db.execute(
      sql`select values_json from telemetry where meter_id = ${mid} order by id desc limit 3`,
    );
    const vals = ((rows as unknown as [Record<string, unknown>[]])[0] ?? []).map((r) =>
      typeof r.values_json === "string" ? JSON.parse(r.values_json) : r.values_json,
    ) as Record<string, number>[];
    const mine = vals.find((v) => v.bmsStatusCode === 9);
    const ok =
      result.decoded === true &&
      !!mine &&
      mine.maxChargePowerKw === 99.9 &&
      mine.maxDischargePowerKw === 99.8;
    console.log(ok ? "PASS" : "FAIL", "bus-unit-3 shifted frame decoded + persisted ->",
      JSON.stringify(mine ?? vals[0] ?? null).slice(0, 300));
    process.exitCode = ok ? 0 : 1;
  } finally {
    await db.delete(telemetry).where(eq(telemetry.meterId, mid));
    await db.delete(alarms).where(eq(alarms.meterId, mid));
    await db.delete(meters).where(eq(meters.id, mid));
    await db.delete(gateways).where(eq(gateways.id, gwId[0].id));
    clearMeterCache();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
