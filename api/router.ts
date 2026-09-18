import { createRouter, publicQuery } from "./middleware";
import { dashboardRouter } from "./routers/dashboard";
import { gatewaysRouter } from "./routers/gateways";
import { metersRouter } from "./routers/meters";
import { alarmsRouter } from "./routers/alarms";
import { reportsRouter } from "./routers/reports";
import { profilesRouter, sitesRouter } from "./routers/profiles";
import { pollerRouter } from "./routers/poller";
import { authRouter } from "./routers/auth";
import { notificationsRouter } from "./routers/notifications";
import { apiKeysRouter } from "./routers/api-keys";
import { webhooksRouter } from "./routers/webhooks";
import { controlRouter } from "./routers/control";
import { emsRouter } from "./routers/ems";
import { otaRouter } from "./routers/ota";
import { orgsRouter } from "./routers/orgs";
import { diagnosticsRouter } from "./routers/diagnostics";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  dashboard: dashboardRouter,
  gateways: gatewaysRouter,
  meters: metersRouter,
  alarms: alarmsRouter,
  reports: reportsRouter,
  profiles: profilesRouter,
  sites: sitesRouter,
  poller: pollerRouter,
  auth: authRouter,
  notifications: notificationsRouter,
  apiKeys: apiKeysRouter,
  webhooks: webhooksRouter,
  control: controlRouter,
  ems: emsRouter,
  ota: otaRouter,
  orgs: orgsRouter,
  diagnostics: diagnosticsRouter,
});

export type AppRouter = typeof appRouter;
