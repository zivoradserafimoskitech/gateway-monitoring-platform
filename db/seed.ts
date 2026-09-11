// Bootstrap seed: the minimum a fresh database needs to be usable.
//
// This used to be the framework's empty TODO template, so there was no
// supported way to bootstrap an installation outside the demo Docker image.
// It now runs the same idempotent steps the demo entrypoint does, in order:
//
//   1. the bootstrap admin user   (scripts/seed-admin.ts)
//   2. the device-profile library (scripts/seed-profiles.ts)
//
// Run AFTER the schema exists (see README, "Database setup"):
//   npx tsx db/seed.ts
//
// Every step is idempotent — re-running never overwrites existing rows.
// Override the admin credentials with ADMIN_EMAIL / ADMIN_PASSWORD /
// ADMIN_NAME; the default password is printed once and must be changed.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const STEPS = [
  { name: "admin user", script: "scripts/seed-admin.ts" },
  { name: "device profiles", script: "scripts/seed-profiles.ts" },
];

function run(script: string): void {
  const res = spawnSync("npx", ["tsx", script], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`${script} exited with status ${res.status ?? "signal " + res.signal}`);
  }
}

console.log("Seeding database...");
for (const step of STEPS) {
  console.log(`\n── ${step.name} ──`);
  run(step.script);
}
console.log("\nDone. Log in with the admin credentials above and change the password.");
