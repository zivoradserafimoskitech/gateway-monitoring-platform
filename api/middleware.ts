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


// ─── Audit attribution ───────────────────────────────────────────────────────
// Anything that commands plant must be attributable to a source address, not
// just an account. The address comes from the reverse proxy's forwarding
// headers (the fetch Request carries no socket), so it is only as trustworthy
// as the proxy in front of the app — see docs/ha.md for the expected topology.
function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first.slice(0, 45);
  }
  return req.headers.get("x-real-ip")?.slice(0, 45) ?? null;
}

function auditAttribution(ctx: TrpcContext) {
  return {
    orgId: ctx.user?.orgId ?? null,
    ip: clientIp(ctx.req),
    userAgent: ctx.req.headers.get("user-agent")?.slice(0, 255) ?? null,
  };
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
              ...auditAttribution(ctx),
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
          ...auditAttribution(ctx),
        })
        .catch((e) => console.warn("[audit] insert failed:", e instanceof Error ? e.message : e));
    }
    return result;
  });
}

export const authed = t.procedure.use(requireRole(["admin", "operator", "viewer"]));
export const operator = t.procedure.use(requireRole(["admin", "operator"]));
export const admin = t.procedure.use(requireRole(["admin"]));

// v8/D2: superadmin-only (org management). Open demo mode (user null) passes,
// consistent with the RBAC bypass.
export const superadmin = t.procedure.use(
  t.middleware(({ ctx, next }) => {
    if (!authBypass()) {
      if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Login required" });
      const isSuper = ctx.user.isSuperadmin === true || (ctx.user.isSuperadmin as unknown) === 1;
      if (ctx.user.role !== "admin" || !isSuper) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Requires superadmin" });
      }
    }
    return next();
  }),
);
