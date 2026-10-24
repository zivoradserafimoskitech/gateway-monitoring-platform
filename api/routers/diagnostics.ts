// Operational counters for the UI.
//
// The meter/gateway detail pages used to fetch the Prometheus text endpoint
// (/metrics) from the BROWSER and regex the counters out of it. That coupled
// the UI to a scrape format and broke outright in the recommended deployment,
// where docs/ha.md restricts /metrics to the monitoring system at the proxy.
// /metrics stays the machine surface; this is the application surface.
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { gateways } from "@db/schema";
import { assertOrgRead, assertOrgWrite, gatewayOrg } from "../lib/org-scope";
import { DIAG_COMMANDS, DISRUPTIVE, getDiag, listDiag, sendDiag } from "../diagnostics/remote";
import { publishDiagCmd } from "../mqtt/service";
import { getC30UndecodableCounts, getTelemetryRejectionStats } from "../lib/observability";

export const diagnosticsRouter = createRouter({
  // Per-register-key counts of decoded values dropped by the profile's
  // plausibility bounds. A wrong scale factor shows up here as a spike
  // instead of as silently stored bad data.
  telemetryRejections: authed.query(() => {
    const stats = getTelemetryRejectionStats();
    let rejected = 0;
    let decoded = 0;
    const byKey: Record<string, { rejected: number; decoded: number }> = {};
    for (const [key, v] of Object.entries(stats)) {
      rejected += v.rejected;
      decoded += v.decoded;
      if (v.rejected > 0) byKey[key] = v;
    }
    return {
      rejected,
      decoded,
      // Share of decoded values that were dropped, 0 when nothing decoded yet.
      rejectedRatio: decoded + rejected > 0 ? rejected / (decoded + rejected) : 0,
      byKey,
      at: Date.now(),
    };
  }),

  // C30 transparent frames that could not be attributed to a known read block.
  // These are the visible signal of the "drop over guess" policy working — or
  // of a misconfigured register map.
  c30Undecodable: authed.query(() => {
    const byReason = getC30UndecodableCounts();
    let total = 0;
    for (const v of Object.values(byReason)) total += v;
    return { total, byReason, at: Date.now() };
  }),

  // ── Remote diagnostics (MQTT g2d/<uid>/diag) ─────────────────────────
  remoteRun: operator
    .input(z.object({ gatewayId: z.number(), cmd: z.enum(DIAG_COMMANDS), args: z.record(z.string(), z.union([z.string(), z.number()])).optional() }))
    .mutation(async ({ ctx, input }) => {
      assertOrgWrite(ctx.user, await gatewayOrg(input.gatewayId), "Gateway");
      if (DISRUPTIVE.has(input.cmd) && ctx.user?.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can run disruptive diagnostics" });
      }
      const [gw] = await getDb().select().from(gateways).where(eq(gateways.id, input.gatewayId)).limit(1);
      if (!gw) throw new TRPCError({ code: "NOT_FOUND", message: "Gateway not found" });
      try {
        const r = await sendDiag(gw, input.cmd, input.args, ctx.user?.id ?? null, publishDiagCmd);
        if (DISRUPTIVE.has(input.cmd)) console.warn(`[diag] ${input.cmd} on gateway ${gw.uid} by user ${ctx.user?.id}`);
        return r;
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
      }
    }),

  remoteResult: authed.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const r = getDiag(input.id);
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown or expired request" });
    assertOrgRead(ctx.user, await gatewayOrg(r.gatewayId), "Gateway");
    return r;
  }),

  remoteHistory: authed.input(z.object({ gatewayId: z.number() })).query(async ({ ctx, input }) => {
    assertOrgRead(ctx.user, await gatewayOrg(input.gatewayId), "Gateway");
    return listDiag(input.gatewayId);
  }),
});
