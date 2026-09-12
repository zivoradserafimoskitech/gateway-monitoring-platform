// Seeds exactly the two accounts tests/e2e/login.spec.ts signs in with.
// Idempotent: an existing account is left untouched, including its password.
//
// These are throwaway credentials for a disposable CI database. Never point
// this at anything that matters — it refuses to run unless the target is
// clearly local or the caller opts in explicitly.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { users } from "../db/schema";
import { hashPassword } from "../api/lib/auth";

const ACCOUNTS = [
  { email: "admin@enertrek.local", name: "E2E Admin", password: "admin1234", role: "admin" as const },
  { email: "viewer@enertrek.local", name: "E2E Viewer", password: "viewer123", role: "viewer" as const },
];

function assertDisposableTarget(): void {
  const url = process.env.DATABASE_URL ?? "";
  const local = /@(127\.0\.0\.1|localhost|mysql|mariadb|db)[:/]/.test(url);
  if (!local && process.env.ALLOW_UNSAFE_PROD !== "1") {
    throw new Error(
      "refusing to seed well-known test passwords into a non-local DATABASE_URL " +
        "(set ALLOW_UNSAFE_PROD=1 only if you are certain)",
    );
  }
}

async function main() {
  assertDisposableTarget();
  const db = getDb();
  for (const a of ACCOUNTS) {
    const existing = await db.select().from(users).where(eq(users.email, a.email)).limit(1);
    if (existing[0]) {
      console.log(`${a.email} already exists (id ${existing[0].id}) — untouched`);
      continue;
    }
    const inserted = await db
      .insert(users)
      .values({ email: a.email, name: a.name, passwordHash: hashPassword(a.password), role: a.role })
      .$returningId();
    console.log(`seeded ${a.role} id=${inserted[0].id} email=${a.email}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
