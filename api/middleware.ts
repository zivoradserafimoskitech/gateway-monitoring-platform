import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { getDb } from "./queries/connection";
import { auditLog } from "@db/schema";

const isDev = process.env.NODE_ENV !== "production";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // Security (v4 F-06): never leak stack traces / absolute paths to clients in
  // production. In dev the stack is kept for debuggability.
  errorFormatter({ shape }) {
    if (isDev) return shape;
    const { stack: _stack, ...rest } = shape.data ?? {};
    return { ...shape, data: rest };
  },
});

export const createRouter = t.router;
export const publicQuery = t.procedure;

// ─── v7/C1: RBAC ─────────────────────────────────────────────────────────────
// AUTH_REQUIRED=false → open demo mode (ctx.user is null and everything is
// allowed). Otherwise:
//   authed    — any logged-in role (read paths)
//   operator  — admin | operator (device/site/alarm mutations)
//   admin     — admin only (users, API keys)
const authBypass = () => process.env.AUTH_REQUIRED === "false";

function summarize(input: unknown): string {
  try {
    const s = JSON.stringify(input, (k, v) =>
      /password|token|secret|key/i.test(k) ? "***" : v,
    );
    return (s ?? "").slice(0, 480);
  } catch {
    return "";
  }
}

function requireRole(roles: Array<"admin" | "operator" | "viewer">) {
  return t.middleware(async ({ ctx, next, path, type, getRawInput }) => {
    // v7/C12: denied mutations are audited too — an operator attempting a
    // forbidden action (e.g. control.execute as viewer) must leave a trail.
    if (!authBypass()) {
      if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Login required" });
      if (!roles.includes(ctx.user.role)) {
        if (type === "mutation") {
          const raw = await getRawInput().catch(() => undefined);
          void getDb()
            .insert(auditLog)
            .values({
              userId: ctx.user.id,
              email: ctx.user.email,
              procedure: path,
              summary: `DENIED(FORBIDDEN): ${summarize(raw)}`,
            })
            .catch(() => undefined);
        }
        throw new TRPCError({ code: "FORBIDDEN", message: `Requires role: ${roles.join(" or ")}` });
      }
    }
    const result = await next();
    // Audit mutations (v7/C1) — successes AND failures (v7/C12: rejected
    // control attempts are security-relevant). Fire-and-forget.
    if (type === "mutation" && !authBypass()) {
      const raw = await getRawInput().catch(() => undefined);
      const summary = result.ok
        ? summarize(raw)
        : `FAILED(${(result.error as { code?: string } | undefined)?.code ?? "ERROR"}): ${summarize(raw)}`;
      void getDb()
        .insert(auditLog)
        .values({
          userId: ctx.user!.id,
          email: ctx.user!.email,
          procedure: path,
          summary,
        })
        .catch((e) => console.warn("[audit] insert failed:", e instanceof Error ? e.message : e));
    }
    return result;
  });
}

export const authed = t.procedure.use(requireRole(["admin", "operator", "viewer"]));
export const operator = t.procedure.use(requireRole(["admin", "operator"]));
export const admin = t.procedure.use(requireRole(["admin"]));
