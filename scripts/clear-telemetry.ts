// Dev helper: wipe telemetry + alarm events (keeps gateways/meters/rules).
import "dotenv/config";
import { assertDestructiveOk } from "./lib/db-guard";
import { getDb } from "../api/queries/connection";
import { telemetry, alarms } from "../db/schema";

async function main() {
  assertDestructiveOk("clear-telemetry");
  const db = getDb();
  await db.delete(alarms);
  await db.delete(telemetry);
  console.log("telemetry + alarms cleared");
  process.exit(0);
}

main();
