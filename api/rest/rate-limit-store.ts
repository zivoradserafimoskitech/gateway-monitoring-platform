// §9.13: the persistence half of the rate limiter. The decision itself is pure
// and lives in ./rate-limit.ts — this file only reads the row, applies that
// decision, and writes it back.
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { apiRateBuckets } from "@db/schema";
import { limitFor, takeToken, type BucketDecision } from "./rate-limit";

export interface RateResult extends BucketDecision {
  limit: number;
}

function affected(res: unknown): number {
  // mysql2 returns [ResultSetHeader, fields]; drizzle passes it through.
  const head = Array.isArray(res) ? res[0] : res;
  return Number((head as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

/** Retries under contention before giving up and letting the request through. */
const MAX_CAS_ATTEMPTS = 3;

/**
 * Consume one token for (key, scope).
 *
 * Compare-and-set rather than a transaction, matching how the leader leases
 * work: read the row, decide in TypeScript, then write conditionally on the
 * timestamp we read. A concurrent request that moved the row first makes the
 * update match nothing, and we re-read.
 *
 * The alternative — expressing the refill arithmetic in SQL so it is one
 * atomic statement — would mean the policy existing twice, once in TypeScript
 * where it is tested and once in a string where it is not. Two copies of a
 * rule drifting apart is a worse failure than the retry this costs.
 *
 * Fails OPEN, in both senses: when the bucket table is unavailable, and when
 * several requests keep losing the CAS race. A rate limiter that rejects
 * traffic because of its own bookkeeping has turned a storage problem into a
 * total outage of the public API — it exists to bound abuse, not to become a
 * second thing that can take the API down.
 */
export async function consume(keyId: number, scope: string, now: Date = new Date()): Promise<RateResult> {
  const limit = limitFor(scope);
  const allowFallback = (): RateResult => ({
    allowed: true,
    next: { tokens: limit.burst, updatedAt: now },
    remaining: limit.burst,
    retryAfterSec: 0,
    limit: limit.perMinute,
  });

  try {
    const db = getDb();
    const where = and(eq(apiRateBuckets.keyId, keyId), eq(apiRateBuckets.scope, scope));
    for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
      const rows = await db
        .select({
          tokens: apiRateBuckets.tokens,
          updatedAt: apiRateBuckets.updatedAt,
          version: apiRateBuckets.version,
        })
        .from(apiRateBuckets)
        .where(where)
        .limit(1);
      const prior = rows[0] ? { tokens: rows[0].tokens, updatedAt: rows[0].updatedAt } : null;
      const decision = takeToken(prior, limit, now);

      // A rejected request writes nothing. The refill it computed is a pure
      // function of elapsed time, so the next read derives it again from the
      // older row — and not writing means a client hammering a limit it has
      // already exhausted costs reads only, which is exactly the moment not
      // to be amplifying writes.
      if (!decision.allowed) return { ...decision, limit: limit.perMinute };

      if (!prior) {
        // First call for this key+scope. INSERT IGNORE rather than an upsert:
        // if another request created the row in between, we lost the race and
        // must re-read rather than overwrite whatever it charged.
        const created = await db.execute(
          sql`INSERT IGNORE INTO api_rate_buckets (key_id, scope, tokens, updated_at, version)
              VALUES (${keyId}, ${scope}, ${decision.next.tokens}, ${decision.next.updatedAt}, 1)`,
        );
        if (affected(created) === 1) return { ...decision, limit: limit.perMinute };
        continue;
      }

      const written = await db
        .update(apiRateBuckets)
        .set({
          tokens: decision.next.tokens,
          updatedAt: decision.next.updatedAt,
          version: rows[0].version + 1,
        })
        // Guarded on the version we read: a concurrent consumer bumps it, so a
        // stale write matches nothing instead of handing back a token somebody
        // else already spent.
        .where(and(where, eq(apiRateBuckets.version, rows[0].version)));
      if (affected(written) === 1) return { ...decision, limit: limit.perMinute };
    }
    // Lost the race MAX_CAS_ATTEMPTS times: that many concurrent requests on
    // one key within a millisecond is itself unusual, and letting a few
    // through is the right direction to be wrong in.
    return allowFallback();
  } catch (e) {
    console.warn("[rate] bucket unavailable, allowing request:", e instanceof Error ? e.message : e);
    return allowFallback();
  }
}
