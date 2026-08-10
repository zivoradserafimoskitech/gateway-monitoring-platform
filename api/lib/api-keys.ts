// v7/C11: API keys for the public REST API (/api/v1/*).
// Keys are `etk_<48 hex>`; only the sha256 hash is stored (same discipline as
// session tokens). Lookups are cached 30s; last_used_at is touched at most
// once per minute per key to keep the hot path write-free.
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { apiKeys, type ApiKey } from "@db/schema";

export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `etk_${crypto.randomBytes(24).toString("hex")}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

const cache = new Map<string, { key: ApiKey | null; at: number }>();
const lastTouch = new Map<string, number>();
const CACHE_MS = 30_000;

export async function lookupApiKey(raw: string): Promise<ApiKey | null> {
  if (!raw.startsWith("etk_")) return null;
  const hash = hashApiKey(raw);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.key;
  const db = getDb();
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
  const key = rows[0] ?? null;
  const valid = key && !key.revokedAt ? key : null;
  cache.set(hash, { key: valid, at: Date.now() });
  if (valid) {
    const last = lastTouch.get(hash) ?? 0;
    if (Date.now() - last > 60_000) {
      lastTouch.set(hash, Date.now());
      db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, valid.id))
        .then(() => undefined)
        .catch(() => undefined);
    }
  }
  return valid;
}

export function evictApiKeyCache(rawOrHash?: string): void {
  if (!rawOrHash) {
    cache.clear();
    return;
  }
  cache.delete(rawOrHash.startsWith("etk_") ? hashApiKey(rawOrHash) : rawOrHash);
}
