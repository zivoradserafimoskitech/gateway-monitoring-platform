// Bulk pre-register the load-test fleet (500 gateways × 16 meters) in one go —
// mirrors real rollouts, where meters are registered at installation time,
// NOT on first data contact. Run before steady-state load tests.
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { gateways, meters } from "../db/schema";

const GATEWAYS = 500;
const METERS_PER = 16;

async function main() {
  const db = getDb();
  const now = new Date();

  for (let g = 0; g < GATEWAYS; g++) {
    const isC30 = g % 10 < 3;
    const uid = isC30 ? `860${String(g).padStart(12, "0")}` : `170${String(g).padStart(12, "0")}`;
    const inserted = await db
      .insert(gateways)
      .values({
        uid,
        name: `${isC30 ? "C30" : "G30"} ${uid}`,
        model: isC30 ? "C30" : "G30",
        transport: isC30 ? "transparent" : "json",
        topicPrefix: isC30 ? "d2g" : "matis/gateway/pVariable",
        status: "offline",
        lastSeenAt: now,
      })
      .$returningId();
    const gatewayId = inserted[0].id;
    const meterRows = Array.from({ length: METERS_PER }, (_, a) => ({
      gatewayId,
      name: `PEM3000 #${a + 1}`,
      model: "PEM3000" as const,
      phases: "three" as const,
      modbusAddress: a + 1,
      status: "offline" as const,
      lastSeenAt: now,
    }));
    await db.insert(meters).values(meterRows);
    if ((g + 1) % 100 === 0) console.log(`provisioned ${g + 1}/${GATEWAYS} gateways`);
  }
  console.log("fleet provisioned");
  process.exit(0);
}
main();
