import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

// audit wave 4 hotfix: pin UTC on BOTH sides of the wire. mysql2's default
// timezone is 'local' (client host tz), while TIMESTAMP columns convert
// through the server session tz — if the two disagree (e.g. a managed TiDB
// node whose system tz/clock changed underneath us, observed 2026-08-14 as an
// exact −8h skew), every timestamp round-trip shifts and time-windowed queries
// silently miss live data. timezone:'Z' makes the driver format/parse Dates as
// UTC; SET time_zone='+00:00' pins the server session so wall↔epoch conversion
// no longer depends on either host's timezone.
export function createUtcPool(extra: mysql.PoolOptions = {}): mysql.Pool {
  const pool = mysql.createPool({ uri: env.databaseUrl, timezone: "Z", ...extra });
  pool.on("connection", (conn) => {
    // pool 'connection' events surface the raw CALLBACK-style connection at
    // runtime despite the promise-pool typings — cast and use callback form.
    (conn as unknown as { query(sql: string, cb: (err: unknown) => void): void })
      .query("SET time_zone = '+00:00'", () => undefined);
  });
  return pool;
}

let instance: ReturnType<typeof createWriteDb> | undefined;

export function getDb() {
  if (!instance) {
    instance = createWriteDb();
  }
  return instance;
}

// Shared builder so every pool (metadata + telemetry write) gets the SAME
// drizzle instantiation type — ReturnType-of-factory avoids the mysql2
// duplicate-Pool-types pitfall between drizzle call forms.
export function createWriteDb(extra: mysql.PoolOptions = {}) {
  return drizzle(createUtcPool(extra), {
    mode: "planetscale",
    schema: fullSchema,
  });
}
