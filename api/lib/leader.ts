// Single-writer leases, held in the database.
//
// The problem: docs/ha.md prescribes two app replicas, but the loops that
// COMMAND plant — the EMS controller, the Modbus poller, the OTA dispatcher —
// run on every replica, and each keeps its idempotency state in a module-level
// Map. Two replicas therefore each believe they are the only one writing
// setpoints, and the 5-minute duplicate-suppression window is per process.
//
// The fix does not need Redis. The report scheduler already proves the pattern:
// a conditional UPDATE that exactly one replica can win, using the database
// that is already a hard dependency. This generalises it into a lease.
//
// Semantics:
//   * A lease is held for `ttlMs` and must be renewed. A replica that dies
//     stops renewing, and another takes over once the lease expires — which is
//     the behaviour you want: control moves, it does not stop.
//   * Losing the lease is not an error. The loop simply skips this tick.
//   * A database failure means NOT the leader. Failing closed is right here:
//     every one of these loops reads its instructions from that same database,
//     so it has nothing useful to do while the database is unreachable.
//
// Single-instance deployments are unaffected: the only replica always wins.
import { randomBytes } from "node:crypto";
import os from "node:os";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";

/** Identifies this process for the lifetime of the process. */
export const HOLDER_ID = `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;

/** Default lease length. Renewal happens every tick, so this only has to
 *  outlast a slow tick — long enough to avoid flapping, short enough that a
 *  crashed replica hands over promptly. */
export const DEFAULT_TTL_MS = 90_000;

let ensured = false;

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await getDb().execute(
    sql.raw(`CREATE TABLE IF NOT EXISTS leader_leases (
      name varchar(64) NOT NULL PRIMARY KEY,
      holder varchar(128) NOT NULL,
      expires_at timestamp NOT NULL
    )`),
  );
  ensured = true;
}

function affected(res: unknown): number {
  // mysql2 returns [ResultSetHeader, fields]; drizzle passes it through.
  const head = Array.isArray(res) ? res[0] : res;
  return Number((head as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

/**
 * Try to take or renew `name`. Returns true when this process may act.
 *
 * Two statements rather than one INSERT ... ON DUPLICATE KEY UPDATE, because
 * the condition ("mine, or expired") has to be evaluated against the stored
 * row, and MySQL's ODKU cannot express that without clobbering another live
 * holder's lease.
 */
export async function acquireLease(name: string, ttlMs: number = DEFAULT_TTL_MS): Promise<boolean> {
  try {
    await ensureTable();
    const db = getDb();
    const expires = new Date(Date.now() + ttlMs);

    // First writer creates the row and is the leader by definition.
    const created = await db.execute(
      sql`INSERT IGNORE INTO leader_leases (name, holder, expires_at) VALUES (${name}, ${HOLDER_ID}, ${expires})`,
    );
    if (affected(created) === 1) return true;

    // Otherwise: renew if it is already ours, or take it if it has lapsed.
    const taken = await db.execute(
      sql`UPDATE leader_leases SET holder = ${HOLDER_ID}, expires_at = ${expires}
          WHERE name = ${name} AND (holder = ${HOLDER_ID} OR expires_at < CURRENT_TIMESTAMP)`,
    );
    return affected(taken) === 1;
  } catch (err) {
    console.warn(
      `[leader] lease '${name}' unavailable (${err instanceof Error ? err.message : err}) — standing down`,
    );
    return false;
  }
}

/** Release early so a redeploy hands over without waiting for the TTL. */
export async function releaseLease(name: string): Promise<void> {
  try {
    await getDb().execute(
      sql`DELETE FROM leader_leases WHERE name = ${name} AND holder = ${HOLDER_ID}`,
    );
  } catch {
    // Best effort: the lease expires on its own.
  }
}

/** Run `fn` only while holding `name`; otherwise skip this tick. */
export async function withLease<T>(
  name: string,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T | undefined> {
  if (!(await hasLease(name, ttlMs))) return undefined;
  return fn();
}

/**
 * May this process act as the single writer for `name`?
 *
 * For loops that manage long-lived resources (the poller's per-device timers)
 * rather than doing discrete work per tick, and so need to know the answer
 * without wrapping a callback.
 *
 * LEADER_LEASES=off opts a deployment out entirely — every replica acts. For
 * a single instance the lease is a round trip per tick that buys nothing.
 */
export async function hasLease(name: string, ttlMs: number = DEFAULT_TTL_MS): Promise<boolean> {
  if (process.env.LEADER_LEASES === "off") return true;
  return acquireLease(name, ttlMs);
}
