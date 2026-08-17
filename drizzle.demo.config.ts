// Wave 7: config used ONLY by the demo/preview image build to snapshot the
// full current schema (db/schema.ts) into db/demo-schema as a fresh
// 0000_*.sql CREATE TABLE set. Unlike drizzle.config.ts it must NOT require
// DATABASE_URL (none exists at image build time) and its out dir must stay
// empty in the build context (db/demo-schema is gitignored + dockerignored)
// so `generate` always emits the full snapshot, never a diff.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/demo-schema",
  dialect: "mysql",
});
