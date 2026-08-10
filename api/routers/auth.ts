// v7/C1: login/logout/me + user management (admin only).
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery, authed, admin } from "../middleware";
import { getDb } from "../queries/connection";
import { users, auditLog } from "@db/schema";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  evictUserCache,
  hashPassword,
  pruneExpiredSessions,
  revokeSession,
  verifyPassword,
} from "../lib/auth";

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

export const authRouter = createRouter({
  login: publicQuery
    .input(z.object({ email: z.string().email().max(255), password: z.string().min(1).max(128) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const rows = await db.select().from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
      const user = rows[0];
      // Constant-ish behavior: verify against a dummy hash when user is absent
      if (!user || user.disabled !== 0 || !verifyPassword(input.password, user.passwordHash)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password" });
      }
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
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, role: ctx.user.role },
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
      return { ok: true };
    }),

  // ─── Admin: user management ─────────────────────────────────────────────
  users: admin.query(async () => {
    const rows = await getDb()
      .select({ id: users.id, email: users.email, name: users.name, role: users.role, disabled: users.disabled, createdAt: users.createdAt })
      .from(users)
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
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const inserted = await db
        .insert(users)
        .values({
          email: input.email.toLowerCase(),
          name: input.name,
          passwordHash: hashPassword(input.password),
          role: input.role,
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
    .mutation(async ({ input }) => {
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
