// v7/C11: public REST API — read-only, Bearer API-key authenticated.
//
//   GET /api/v1/sites                all sites
//   GET /api/v1/devices              meters + gateway/site context
//   GET /api/v1/devices/:id/latest   latest telemetry row for one device
//   GET /api/v1/devices/:id/energy   v8/D2: settlement energy intervals
//   GET /api/v1/alarms[?status=]     alarms (default: active)
//
// Auth: `Authorization: Bearer etk_...` with a non-revoked key. Keys are
// managed via the tRPC apiKeys router (admin) — see docs/api-v1.md.
import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { alarms, gateways, meters, sites } from "@db/schema";
import { lookupApiKey } from "../lib/api-keys";
import { getTelemetryStore } from "../telemetry";

type Vars = { Variables: { apiKey: { id: number; name: string; role: string; orgId: number | null } } };
export const restV1 = new Hono<Vars>();

restV1.use("*", async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const key = raw ? await lookupApiKey(raw) : null;
  if (!key) {
    return c.json({ error: "Unauthorized — a valid Bearer API key is required (etk_...)" }, 401);
  }
  c.set("apiKey", { id: key.id, name: key.name, role: key.role, orgId: key.orgId });
  await next();
});

// v8/D2 multitenancy: every REST read is scoped to the key's org (keys are
// backfilled to Default Org, so legacy integrations are unaffected).
restV1.get("/sites", async (c) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(sites)
    .where(eq(sites.orgId, c.get("apiKey").orgId ?? -1))
    .orderBy(sites.name);
  return c.json({ sites: rows });
});

restV1.get("/devices", async (c) => {
  const db = getDb();
  // Contract core (v8/D2): { id, name, model, deviceType, siteId, gatewayId,
  // status } — plus backward-compatible extras (gateway context, effectiveSiteId).
  const rows = await db
    .select({
      id: meters.id,
      name: meters.name,
      model: meters.model,
      deviceType: meters.deviceType,
      siteId: meters.siteId,
      gatewayId: meters.gatewayId,
      status: meters.status,
      modbusAddress: meters.modbusAddress,
      gatewayUid: gateways.uid,
      gatewayModel: gateways.model,
      gatewayStatus: gateways.status,
      gatewaySiteId: gateways.siteId,
    })
    .from(meters)
    .leftJoin(gateways, eq(meters.gatewayId, gateways.id))
    .where(eq(meters.orgId, c.get("apiKey").orgId ?? -1))
    .orderBy(meters.id);
  // v6 coalesce rule: a meter's effective site = own site ?? gateway's site.
  const withSite = rows.map((r) => ({ ...r, effectiveSiteId: r.siteId ?? r.gatewaySiteId ?? null }));
  return c.json({ devices: withSite });
});

restV1.get("/devices/:id/latest", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid device id" }, 400);
  const db = getDb();
  const dev = await db.select({ id: meters.id }).from(meters).where(and(eq(meters.id, id), eq(meters.orgId, c.get("apiKey").orgId ?? -1))).limit(1);
  if (dev.length === 0) return c.json({ error: "device not found" }, 404);
  const row = await getTelemetryStore().latest(id);
  // v8/D2 contract shape { deviceId, ts, values }; the legacy `latest` wrapper
  // is kept for existing consumers (probe-v7-rest-api).
  if (!row) return c.json({ deviceId: id, ts: null, values: {}, latest: null });
  return c.json({ deviceId: id, ts: row.ts, values: row.values, latest: { ts: row.ts, values: row.values } });
});

// v8/D2: settlement-grade energy intervals for ERP/billing integrations.
// UTC-aligned consecutive buckets; counter-reset-safe non-negative deltas;
// ranges older than the retention cutoff are served from hourly aggregates.
const MAX_RANGE_MS = 31 * 86_400_000;
restV1.get("/devices/:id/energy", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid device id" }, 400);
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  if (!fromRaw || !toRaw) return c.json({ error: "from and to query params (ISO8601) are required" }, 400);
  const fromMs = Date.parse(fromRaw);
  const toMs = Date.parse(toRaw);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return c.json({ error: "unparsable from/to — use ISO8601" }, 400);
  if (fromMs >= toMs) return c.json({ error: "from must be before to" }, 400);
  if (toMs - fromMs > MAX_RANGE_MS) return c.json({ error: "range must not exceed 31 days" }, 400);
  const bucketRaw = c.req.query("bucketMin");
  const bucketMin = bucketRaw === undefined ? 60 : Number(bucketRaw);
  if (!Number.isInteger(bucketMin) || bucketMin < 15 || bucketMin > 1440) {
    return c.json({ error: "bucketMin must be an integer in 15..1440" }, 400);
  }
  const db = getDb();
  const dev = await db.select({ id: meters.id }).from(meters).where(and(eq(meters.id, id), eq(meters.orgId, c.get("apiKey").orgId ?? -1))).limit(1);
  if (dev.length === 0) return c.json({ error: "device not found" }, 404);

  const rows = await getTelemetryStore().energyIntervals(id, new Date(fromMs), new Date(toMs), bucketMin);
  const byStart = new Map(rows.map((r) => [r.bucketStartSec, r]));
  // Consecutive UTC-aligned grid: floor(from) … ceil(to); gaps → nulls.
  const bucketSec = bucketMin * 60;
  const first = Math.floor(fromMs / 1000 / bucketSec);
  const count = Math.ceil(toMs / 1000 / bucketSec) - first;
  const buckets = Array.from({ length: count }, (_, i) => {
    const startSec = (first + i) * bucketSec;
    const r = byStart.get(startSec);
    return {
      ts: new Date(startSec * 1000).toISOString(),
      importKwh: r?.importKwh ?? null,
      exportKwh: r?.exportKwh ?? null,
      avgPowerKw: r?.avgPowerKw ?? null,
      quality: r?.estimated ? ("estimated" as const) : ("measured" as const),
    };
  });
  return c.json({
    deviceId: id,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    bucketMin,
    buckets,
  });
});

restV1.get("/alarms", async (c) => {
  const status = c.req.query("status") ?? "active";
  const valid = ["active", "acknowledged", "resolved", "all"];
  if (!valid.includes(status)) return c.json({ error: `status must be one of ${valid.join("|")}` }, 400);
  const db = getDb();
  // v8/D2: scope to the key's org through the meter (or the gateway for
  // meter-less alarms).
  const org = c.get("apiKey").orgId ?? -1;
  const [mRows, gRows] = await Promise.all([
    db.select({ id: meters.id }).from(meters).where(eq(meters.orgId, org)),
    db.select({ id: gateways.id }).from(gateways).where(eq(gateways.orgId, org)),
  ]);
  const mIds = mRows.map((r) => r.id);
  const gIds = gRows.map((r) => r.id);
  const orgScope =
    mIds.length || gIds.length
      ? or(mIds.length ? inArray(alarms.meterId, mIds) : undefined, gIds.length ? and(isNull(alarms.meterId), inArray(alarms.gatewayId, gIds)) : undefined)
      : eq(alarms.meterId, -1);
  const cols = {
    id: alarms.id,
    meterId: alarms.meterId,
    gatewayId: alarms.gatewayId,
    metric: alarms.metric,
    value: alarms.value,
    threshold: alarms.threshold,
    severity: alarms.severity,
    message: alarms.message,
    status: alarms.status,
    triggeredAt: alarms.triggeredAt,
    acknowledgedAt: alarms.acknowledgedAt,
    resolvedAt: alarms.resolvedAt,
  };
  const rows = await db
    .select(cols)
    .from(alarms)
    .where(and(status === "all" ? undefined : eq(alarms.status, status as "active" | "acknowledged" | "resolved"), orgScope))
    .orderBy(desc(alarms.triggeredAt))
    .limit(500);
  return c.json({ alarms: rows });
});
