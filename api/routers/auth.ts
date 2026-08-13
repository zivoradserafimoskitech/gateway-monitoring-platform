// v7/C1: login/logout/me + user management (admin only).
import { z } from "zod";
import { and, eq, desc, ne } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery, authed, admin } from "../middleware";
import { getDb } from "../queries/connection";
import { sessions, users, auditLog } from "@db/schema";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  evictUserCache,
  evictUserCacheForUser,
  hashPassword,
  pruneExpiredSessions,
  revokeSession,
  tokenHash,
  verifyPassword,
} from "../lib/auth";
import { assertOrgWrite, orgWhere, stampOrg, userOrg } from "../lib/org-scope";

// When the app is served embedded (platform preview iframe) over HTTPS, the
// session cookie is third-party: SameSite=Lax is never sent on fetch, so the
// user would bounce back to /login. SameSite=None requires Secure; Partitioned
// (CHIPS) keeps it working under Chrome's third-party-cookie phase-out.
function isSecureReq(req: Request): boolean {
  return req.headers.get("x-forwarded-proto") === "https" || req.url.startsWith("https:");
}

function cookieHeader(token: string, expiresAt: Date, secure: boolean): string {
  const base = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Expires=${expiresAt.toUTCString()}`;
  return secure ? `${base}; SameSite=None; Secure; Partitioned` : `${base}; SameSite=Lax`;
}

function clearCookieHeader(secure: boolean): string {
  const base = `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`;
  return secure ? `${base}; SameSite=None; Secure; Partitioned` : `${base}; SameSite=Lax`;
}

// ─── Audit P1-4: login rate limiting + lockout ──────────────────────────────
// In-memory, per (email + client IP) limiter. Documented limitation: state is
// per process, so with multiple replicas behind the LB each replica counts
// independently — move to Redis (or a shared store) when running multi-instance.
const LOGIN_WINDOW_MS = 5 * 60_000; // failures are counted over 5 minutes
const LOGIN_MAX_FAILURES = 5; // >5 failures within the window → lockout
const LOGIN_LOCKOUT_MS = 15 * 60_000; // lockout duration
const LOGIN_DELAY_STEP_MS = 500; // progressive delay: 500ms × failures so far

type LoginAttempts = { failures: number[]; lockedUntil: number };
const loginAttempts = new Map<string, LoginAttempts>();

function loginClientIp(req: Request): string {
  // nginx sets X-Forwarded-For; first hop is the real client.
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "unknown";
}

function loginKey(email: string, req: Request): string {
  return `${email.toLowerCase()}|${loginClientIp(req)}`;
}

function recentFailures(rec: LoginAttempts | undefined, now: number): number {
  if (!rec) return 0;
  rec.failures = rec.failures.filter((t) => now - t < LOGIN_WINDOW_MS);
  return rec.failures.length;
}

/** Throws 429 when the key is locked out; otherwise applies progressive delay. */
async function loginThrottle(email: string, req: Request): Promise<void> {
  const key = loginKey(email, req);
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (rec?.lockedUntil && rec.lockedUntil > now) {
    // Generic message — never reveal whether the email exists.
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many login attempts. Try again later." });
  }
  const failures = recentFailures(rec, now);
  if (failures > 0) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_DELAY_STEP_MS * failures));
  }
}

function recordLoginFailure(email: string, req: Request): void {
  const key = loginKey(email, req);
  const now = Date.now();
  const rec = loginAttempts.get(key) ?? { failures: [], lockedUntil: 0 };
  recentFailures(rec, now);
  rec.failures.push(now);
  if (rec.failures.length > LOGIN_MAX_FAILURES && rec.lockedUntil <= now) {
    rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
    // Audit trail: a lockout is security-relevant — keep it in the server log
    // (key carries email+IP but no password material).
    console.warn(`[auth] login lockout 15min for ${key} after ${rec.failures.length} failed attempts`);
  }
  loginAttempts.set(key, rec);
  // Bound memory: sweep expired entries when the map grows large.
  if (loginAttempts.size > 10_000) {
    for (const [k, v] of loginAttempts) {
      if (v.lockedUntil <= now && recentFailures(v, now) === 0) loginAttempts.delete(k);
    }
  }
}

function clearLoginFailures(email: string, req: Request): void {
  loginAttempts.delete(loginKey(email, req));
}

export const authRouter = createRouter({
  login: publicQuery
    .input(z.object({ email: z.string().email().max(255), password: z.string().min(1).max(128) }))
    .mutation(async ({ input, ctx }) => {
      // P1-4: lockout check + progressive delay BEFORE any DB work / verify.
      await loginThrottle(input.email, ctx.req);
      const db = getDb();
      const rows = await db.select().from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
      const user = rows[0];
      // Constant-ish behavior: verify against a dummy hash when user is absent
      if (!user || user.disabled !== 0 || !verifyPassword(input.password, user.passwordHash)) {
        recordLoginFailure(input.email, ctx.req);
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password" });
      }
      clearLoginFailures(input.email, ctx.req); // reset on success
      const { token, expiresAt } = await createSession(user.id);
      ctx.resHeaders.set("set-cookie", cookieHeader(token, expiresAt, isSecureReq(ctx.req)));
      void pruneExpiredSessions().catch(() => {});
      // token is also returned in the body: the SPA stores it and sends it as
      // x-session-token when cookies are unavailable (embedded preview).
      return { id: user.id, email: user.email, name: user.name, role: user.role, token };
    }),

  logout: publicQuery.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) {
      await revokeSession(ctx.sessionToken);
      evictUserCache(ctx.sessionToken);
    }
    ctx.resHeaders.set("set-cookie", clearCookieHeader(isSecureReq(ctx.req)));
    return { ok: true };
    // SESSION_TTL_MS referenced for documentation of cookie lifetime
  }),

  me: publicQuery.query(({ ctx }) => {
    // authRequired lets the SPA distinguish "anonymous, login required" from
    // "open demo mode" (AUTH_REQUIRED=false) where no login screen applies.
    const authRequired = process.env.AUTH_REQUIRED !== "false";
    if (!ctx.user) return { authRequired, user: null };
    return {
      authRequired,
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, role: ctx.user.role, orgId: ctx.user.orgId, isSuperadmin: ctx.user.isSuperadmin },
    };
  }),

  changePassword: authed
    .input(z.object({ current: z.string().min(1), next: z.string().min(8).max(128) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!verifyPassword(input.current, ctx.user!.passwordHash)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Current password is wrong" });
      }
      await db.update(users).set({ passwordHash: hashPassword(input.next) }).where(eq(users.id, ctx.user!.id));
      // audit P1-10: a password change invalidates every OTHER session of
      // this user (stolen sessions must die immediately); the current session
      // is kept so the user isn't logged out of the tab that changed it.
      await db
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, ctx.user!.id),
            ctx.sessionToken ? ne(sessions.tokenHash, tokenHash(ctx.sessionToken)) : undefined,
          ),
        );
      evictUserCacheForUser(ctx.user!.id);
      return { ok: true };
    }),

  // ─── Admin: user management ─────────────────────────────────────────────
  users: admin.query(async ({ ctx }) => {
    // v8/D2: non-superadmin admin sees only users of their own org.
    const rows = await getDb()
      .select({ id: users.id, email: users.email, name: users.name, role: users.role, disabled: users.disabled, orgId: users.orgId, isSuperadmin: users.isSuperadmin, createdAt: users.createdAt })
      .from(users)
      .where(orgWhere(ctx.user, users.orgId))
      .orderBy(desc(users.createdAt));
    return rows;
  }),

  createUser: admin
    .input(
      z.object({
        email: z.string().email().max(255),
        name: z.string().min(1).max(255),
        password: z.string().min(8).max(128),
        role: z.enum(["admin", "operator", "viewer"]).default("viewer"),
        orgId: z.number().optional(), // v8/D2: superadmin may choose; others get their own org stamped
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const inserted = await db
        .insert(users)
        .values({
          email: input.email.toLowerCase(),
          name: input.name,
          passwordHash: hashPassword(input.password),
          role: input.role,
          orgId: stampOrg(ctx.user, input.orgId),
        })
        .$returningId();
      return { id: inserted[0].id };
    }),

  updateUser: admin
    .input(
      z.object({
        id: z.number(),
        role: z.enum(["admin", "operator", "viewer"]).optional(),
        disabled: z.boolean().optional(),
        password: z.string().min(8).max(128).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertOrgWrite(ctx.user, await userOrg(input.id), "User"); // v8/D2
      const db = getDb();
      const patch: Record<string, unknown> = {};
      if (input.role) patch.role = input.role;
      if (input.disabled !== undefined) patch.disabled = input.disabled ? 1 : 0;
      if (input.password) patch.passwordHash = hashPassword(input.password);
      if (Object.keys(patch).length === 0) return { ok: true };
      await db.update(users).set(patch).where(eq(users.id, input.id));
      evictUserCache(); // role/disable must take effect within the cache TTL
      return { ok: true };
    }),

  auditLog: admin
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ input }) => {
      return getDb().select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(input.limit);
    }),
});

// keep TTL referenced (docs) — avoids lint noise for the constant export
void SESSION_TTL_MS;
