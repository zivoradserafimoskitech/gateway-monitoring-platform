import { createRouter, publicQuery } from "./middleware";
import { dashboardRouter } from "./routers/dashboard";
import { gatewaysRouter } from "./routers/gateways";
import { metersRouter } from "./routers/meters";
import { alarmsRouter } from "./routers/alarms";
import { reportsRouter } from "./routers/reports";
import { profilesRouter, sitesRouter } from "./routers/profiles";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  dashboard: dashboardRouter,
  gateways: gatewaysRouter,
  meters: metersRouter,
  alarms: alarmsRouter,
  reports: reportsRouter,
  profiles: profilesRouter,
  sites: sitesRouter,
});

export type AppRouter = typeof appRouter;
