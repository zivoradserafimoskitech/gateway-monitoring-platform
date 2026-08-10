import { z } from "zod";
import { createRouter, authed } from "../middleware";
import { queryEnergyReport } from "../reports/energy-query";
import { reportSchedulesRouter } from "./reports-schedules";

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
    .query(async ({ input }) => queryEnergyReport(input)),

  // v8/D3: scheduled reports (list/create/update/remove/runNow).
  schedules: reportSchedulesRouter,
});
