// Ordered, idempotent, tracked migration runner.
//
// Why this exists instead of `drizzle-kit migrate`: the drizzle journal
// (db/migrations/meta/_journal.json) stops at index 13, while the SQL files
// from 0014 onwards were written by hand. drizzle-kit therefore neither knows
// about them nor can replay them, and the 0000-0013 SQL files are absent
// entirely because db/migrations/*.sql used to be gitignored. Bootstrapping a
// brand-new database is done from the schema snapshot (see README); this
// runner applies every incremental .sql file after that, in filename order,
// exactly once, recording what it applied.
//
//   npx tsx scripts/apply-migrations.ts           # apply pending
//   npx tsx scripts/apply-migrations.ts --dry-run # list pending, change nothing
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "../api/queries/connection";

const DIR = "db/migrations";

// Split on drizzle's breakpoint marker when present, else on statement
// semicolons at end of line. Keeps multi-line statements intact.
function statements(body: string): string[] {
  const stripped = body
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const parts = stripped.includes("--> statement-breakpoint")
    ? stripped.split("--> statement-breakpoint")
    : stripped.split(/;\s*$/m);
  return parts.map((s) => s.trim().replace(/;$/, "")).filter(Boolean);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = getDb();

  await db.execute(
    sql.raw(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename varchar(255) NOT NULL PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
  );

  const applied = new Map<string, string>();
  const result = (await db.execute(
    sql.raw("SELECT filename, checksum FROM schema_migrations"),
  )) as unknown as [{ filename: string; checksum: string }[], unknown];
  for (const r of result[0] ?? []) applied.set(r.filename, r.checksum);

  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let pending = 0;
  for (const file of files) {
    const body = readFileSync(path.join(DIR, file), "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const seen = applied.get(file);

    if (seen) {
      // A migration that changed after being applied means the deployed schema
      // and the repository have diverged. Refuse rather than guess.
      if (seen !== checksum) {
        throw new Error(
          `${file} was already applied but its contents changed ` +
            `(recorded ${seen.slice(0, 12)}, now ${checksum.slice(0, 12)}). ` +
            `Write a new migration instead of editing an applied one.`,
        );
      }
      continue;
    }

    pending++;
    if (dryRun) {
      console.log("pending:", file);
      continue;
    }

    console.log("applying:", file);
    for (const stmt of statements(body)) {
      try {
        await db.execute(sql.raw(stmt));
      } catch (e) {
        const msg = [
          e instanceof Error ? e.message : String(e),
          (e as { cause?: { message?: string } })?.cause?.message ?? "",
        ].join(" ");
        // Re-running an additive migration against a database that already has
        // the column/index is normal on mixed-age fleets; anything else is real.
        if (/already exists|Duplicate (column|key)/i.test(msg)) {
          console.log("  skip (already present):", stmt.slice(0, 60).replace(/\n/g, " "));
          continue;
        }
        throw e;
      }
    }
    await db.execute(
      sql`INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})`,
    );
  }

  console.log(dryRun ? `${pending} pending migration(s)` : `done — ${pending} applied`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
