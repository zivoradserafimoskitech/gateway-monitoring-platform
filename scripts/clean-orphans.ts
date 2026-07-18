import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { gateways, meters, telemetry } from "../db/schema";
import { sql, inArray } from "drizzle-orm";

async function main() {
  const db = getDb();
  const orphans = await db
    .select({ id: meters.id })
    .from(meters)
    .leftJoin(gateways, sql`${meters.gatewayId} = ${gateways.id}`)
    .where(sql`${gateways.id} is null`);
  const ids = orphans.map((o) => o.id);
  console.log("orphan meters:", ids.length);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await db.delete(telemetry).where(inArray(telemetry.meterId, chunk));
    await db.delete(meters).where(inArray(meters.id, chunk));
  }
  console.log("orphans removed");
  process.exit(0);
}
main();
