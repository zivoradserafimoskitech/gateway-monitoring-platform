// v7/C1: seed the bootstrap admin user. Idempotent.
// Env overrides: ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME.
// Default password is printed once — CHANGE IT after first login.
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "../api/lib/auth";

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "admin@enertrek.local").toLowerCase();
  const name = process.env.ADMIN_NAME ?? "Administrator";
  const password = process.env.ADMIN_PASSWORD ?? "admin1234";
  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) {
    console.log(`admin already exists: ${email} (id ${existing[0].id}) — untouched`);
    process.exit(0);
  }
  const inserted = await db
    .insert(users)
    .values({ email, name, passwordHash: hashPassword(password), role: "admin" })
    .$returningId();
  console.log(`seeded admin id=${inserted[0].id} email=${email}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`default password: ${password}  — CHANGE IT after first login (auth.changePassword)`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
