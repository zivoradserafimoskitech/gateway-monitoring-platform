// v7/C1: password hashing (scrypt, no deps) + session tokens.
import crypto from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { sessions, users } from "@db/schema";
import type { User } from "@db/schema";

const SCRYPT_N = 16384;
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
export const SESSION_COOKIE = "et_session";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N });
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64, { N: SCRYPT_N });
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

export function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getDb().insert(sessions).values({ tokenHash: tokenHash(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function revokeSession(token: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
}

// Short-lived in-process cache — the DB lookup would otherwise run per tRPC call.
const userCache = new Map<string, { at: number; user: User | null }>();
const USER_CACHE_TTL_MS = 30_000;

export async function userForToken(token: string | undefined | null): Promise<User | null> {
  if (!token) return null;
  const th = tokenHash(token);
  const cached = userCache.get(th);
  if (cached && Date.now() - cached.at < USER_CACHE_TTL_MS) return cached.user;
  const db = getDb();
  const rows = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, th))
    .limit(1);
  let user: User | null = null;
  if (rows[0] && rows[0].session.expiresAt > new Date() && rows[0].user.disabled === 0) {
    user = rows[0].user;
  }
  userCache.set(th, { at: Date.now(), user });
  return user;
}

export function evictUserCache(token?: string): void {
  if (token) userCache.delete(tokenHash(token));
  else userCache.clear();
}

// audit P1-10: drop every cached user lookup belonging to one user (e.g.
// after a password change invalidates their other sessions — without this the
// 30 s cache would keep the deleted sessions "alive").
export function evictUserCacheForUser(userId: number): void {
  for (const [th, entry] of userCache) {
    if (entry.user?.id === userId) userCache.delete(th);
  }
}

// Opportunistic sweep of expired sessions (called on login — cheap, rare enough).
export async function pruneExpiredSessions(): Promise<void> {
  await getDb().delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
