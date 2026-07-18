// Dev helper: wipe telemetry + alarm events (keeps gateways/meters/rules).
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { telemetry, alarms } from "../db/schema";

async function main() {
  const db = getDb();
  await db.delete(alarms);
  await db.delete(telemetry);
  console.log("telemetry + alarms cleared");
  process.exit(0);
}

main();
