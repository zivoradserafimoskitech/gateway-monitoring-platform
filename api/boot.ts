import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { startMqttService } from "./mqtt/service";
import { startPollerService } from "./poller/service";
import { startEscalationLoop } from "./alarms/notify";
import { metricsText, httpRequestDone, startWatchdogLoop } from "./lib/observability";
import crypto from "node:crypto";

// Start MQTT ingestion (embedded broker unless MQTT_URL points to an external one).
// Failures must not take down the HTTP API.
startMqttService().catch((err) => {
  console.error("[mqtt] failed to start:", err instanceof Error ? err.message : err);
});

// Start the Modbus TCP poller (direct-connected inverters / BESS). No-op when
// no devices carry host/port.
try {
  startPollerService();
  startEscalationLoop(); // v7/C2
  // v7/C5: retention + downsampling (MySQL store only — TimescaleDB uses
  // native continuous aggregates + retention policies).
  const storeKind = process.env.TELEMETRY_STORE || (process.env.TIMESCALE_URL ? "timescale" : "mysql");
  if (storeKind !== "timescale") {
    const { startRetentionLoop } = await import("./telemetry/rollup");
    startRetentionLoop();
  }
  startWatchdogLoop(); // v7/C9
  // v8/D1: automatic EMS (BESS schedules + peak shaving).
  const { startEmsLoop } = await import("./ems/controller");
  startEmsLoop();
  // v8/D3: scheduled reports (generate + email).
  const { startReportLoop } = await import("./reports/scheduler");
  startReportLoop();
} catch (err) {
  console.error("[poller] failed to start:", err instanceof Error ? err.message : err);
}

const app = new Hono<{ Bindings: HttpBindings }>();

// tRPC payloads are small JSON — 50 MB was a DoS surface (v4 F-09).
app.use(bodyLimit({ maxSize: 2 * 1024 * 1024 }));

// v7/C9: request-id + access log for every API call (slow/error requests are
// warned; all requests feed the /metrics http counters).
app.use("/api/*", async (c, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  c.header("x-request-id", reqId);
  httpRequestDone(c.req.method, c.req.path, c.res.status, ms, reqId);
});

// v7/C9: Prometheus scrape endpoint. Intentionally outside /api/trpc auth —
// point your scraper at it or front it with basic auth in the reverse proxy.
app.get("/metrics", async (c) => {
  c.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
  return c.body(await metricsText());
});

// Optional bearer-token guard for real deployments (v4 F-01): when API_TOKEN is
// set, every API call must send `Authorization: Bearer <token>`. The frontend
// sends it from VITE_API_TOKEN (build time). Unset = open demo mode.
app.use("/api/trpc/*", async (c, next) => {
  const token = process.env.API_TOKEN;
  if (token && c.req.header("authorization") !== `Bearer ${token}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});

// v7/C11: public REST API (Bearer API-key auth — see api/rest/v1.ts).
const { restV1 } = await import("./rest/v1");
app.route("/api/v1", restV1);

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
