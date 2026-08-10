// Remove load-test fleet (UIDs 170XXXXXXXXXXXX / 860XXXXXXXXXXXX) + its data.
import "dotenv/config";
import { assertDestructiveOk } from "./lib/db-guard";
import { getDb } from "../api/queries/connection";
import { gateways, meters, telemetry, alarms } from "../db/schema";
import { like, or, inArray, eq } from "drizzle-orm";

async function main() {
  assertDestructiveOk("cleanup-scale");
  const db = getDb();
  const gws = await db
    .select({ id: gateways.id })
    .from(gateways)
    .where(or(like(gateways.uid, "170%"), like(gateways.uid, "860%")));
  const ids = gws.map((g) => g.id);
  console.log(`scale gateways to remove: ${ids.length}`);
  if (ids.length > 0) {
    const mts = await db.select({ id: meters.id }).from(meters).where(inArray(meters.gatewayId, ids));
    const mIds = mts.map((m) => m.id);
    console.log(`scale meters to remove: ${mIds.length}`);
    if (mIds.length > 0) {
      // chunked deletes
      for (let i = 0; i < mIds.length; i += 500) {
        const chunk = mIds.slice(i, i + 500);
        await db.delete(telemetry).where(inArray(telemetry.meterId, chunk));
        await db.delete(alarms).where(inArray(alarms.meterId, chunk));
      }
      for (let i = 0; i < mIds.length; i += 500) {
        await db.delete(meters).where(inArray(meters.id, mIds.slice(i, i + 500)));
      }
    }
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await db.delete(alarms).where(inArray(alarms.gatewayId, chunk));
      await db.delete(gateways).where(inArray(gateways.id, chunk));
    }
  }
  console.log("cleanup done");
  process.exit(0);
}
main();
