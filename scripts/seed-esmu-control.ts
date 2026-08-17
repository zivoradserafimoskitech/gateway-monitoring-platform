// Wave 7 (demo image): after provision-esmu-demo, mark the esmu-bams-stack
// profile bench_verified with the controllable whitelist so Control/EMS works
// in the self-contained preview — mirrors the dev DB state (see the setup
// block in scripts/probe-v9-ems-plan.ts). Idempotent UPDATE.
// Run: npx tsx scripts/seed-esmu-control.ts
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { deviceProfiles } from "../db/schema";

async function main() {
  const db = getDb();
  await db
    .update(deviceProfiles)
    .set({
      verificationStatus: "bench_verified",
      controllable: {
        activePowerKw: {
          address: 41000,
          fc: 6,
          min: 0,
          max: 250,
          scale: 10,
          unit: "kW",
          description: "PCS active power setpoint (+ = discharge)",
        },
      },
    })
    .where(eq(deviceProfiles.model, "esmu-bams-stack"));
  console.log("esmu-bams-stack profile: bench_verified + activePowerKw whitelist (addr 41000 fc6 0-250kW scale 10)");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
