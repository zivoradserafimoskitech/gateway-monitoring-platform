import { z } from "zod";
import { createRouter, authed } from "../middleware";
import { queryEnergyReport } from "../reports/energy-query";
import { reportSchedulesRouter } from "./reports-schedules";
import { assertOrgRead, isSuper, meterOrg, siteOrg } from "../lib/org-scope";

export const reportsRouter = createRouter({
  energy: authed
    .input(
      z.object({
        scope: z.enum(["meter", "site"]),
        meterId: z.number().optional(),
        siteId: z.number().optional(),
        from: z.date(),
        to: z.date(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // v8/D2: validate the scope target against the caller's org (404 on
      // foreign), then let the query filter to org-owned devices.
      if (input.scope === "meter" && input.meterId != null) {
        assertOrgRead(ctx.user, await meterOrg(input.meterId), "Device");
      }
      if (input.scope === "site" && input.siteId != null) {
        assertOrgRead(ctx.user, await siteOrg(input.siteId), "Site");
      }
      return queryEnergyReport({ ...input, orgId: isSuper(ctx.user) ? undefined : (ctx.user?.orgId ?? -1) });
    }),

  // v8/D3: scheduled reports (list/create/update/remove/runNow).
  schedules: reportSchedulesRouter,
});
