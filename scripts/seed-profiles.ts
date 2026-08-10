// Seeds the device profile library into device_profiles.
// INSERT-ONLY per model by default: profiles are user-editable configuration, so
// existing rows are never overwritten. Run: npx tsx scripts/seed-profiles.ts
// --refresh : also UPDATE existing library-model rows from the library (dev/
//             upgrade path — discards any UI edits made to those models).
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { deviceProfiles } from "../db/schema";
import { DEVICE_PROFILE_LIBRARY } from "../db/device-profile-library";
import { DEFAULT_REGISTER_MAPS } from "@contracts/modbus";

const db = getDb();

// Meter profiles (historically seeded lazily by the ingestion path) — seed them
// here too so brand/deviceType metadata is present from the start.
const METER_PROFILES = [
  { model: "SEM2250", label: "SEM2250 single-phase meter (default map)", brand: "Enertrek" },
  { model: "SEM3250", label: "SEM3250 three-phase meter (default map)", brand: "Enertrek" },
  { model: "PEM3000", label: "PEM3000 three-phase meter (default map)", brand: "Enertrek" },
];

const REFRESH = process.argv.includes("--refresh");

let inserted = 0;
let skipped = 0;
let updated = 0;

for (const m of METER_PROFILES) {
  const existing = await db.select({ id: deviceProfiles.id }).from(deviceProfiles).where(eq(deviceProfiles.model, m.model)).limit(1);
  if (existing[0]) {
    skipped++;
    continue;
  }
  await db.insert(deviceProfiles).values({
    model: m.model,
    label: m.label,
    brand: m.brand,
    deviceType: "meter",
    protocol: "rtu",
    source: "template",
    notes: "Default float32 input-register layout; verify against vendor protocol document.",
    registerMap: DEFAULT_REGISTER_MAPS[m.model as keyof typeof DEFAULT_REGISTER_MAPS],
  });
  inserted++;
}

for (const p of DEVICE_PROFILE_LIBRARY) {
  const existing = await db.select({ id: deviceProfiles.id }).from(deviceProfiles).where(eq(deviceProfiles.model, p.model)).limit(1);
  if (existing[0]) {
    if (REFRESH) {
      await db.update(deviceProfiles).set({
        label: p.label,
        brand: p.brand,
        deviceType: p.deviceType,
        protocol: p.protocol,
        source: p.source,
        sourceUrl: p.sourceUrl ?? null,
        notes: p.notes ?? null,
        registerMap: p.registerMap,
        faultCodes: p.faultCodes ?? null,
      }).where(eq(deviceProfiles.model, p.model));
      updated++;
    } else {
      skipped++;
    }
    continue;
  }
  await db.insert(deviceProfiles).values({
    model: p.model,
    label: p.label,
    brand: p.brand,
    deviceType: p.deviceType,
    protocol: p.protocol,
    source: p.source,
    sourceUrl: p.sourceUrl ?? null,
    notes: p.notes ?? null,
    registerMap: p.registerMap,
    faultCodes: p.faultCodes ?? null,
  });
  inserted++;
}

console.log(`profiles seeded: ${inserted} inserted, ${skipped} already present (untouched)${REFRESH ? `, ${updated} refreshed from library` : ""}`);
process.exit(0);
