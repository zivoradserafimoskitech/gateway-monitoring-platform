// v7/C11: public REST API — read-only, Bearer API-key authenticated.
//
//   GET /api/v1/sites                all sites
//   GET /api/v1/devices              meters + gateway/site context
//   GET /api/v1/devices/:id/latest   latest telemetry row for one device
//   GET /api/v1/devices/:id/energy   v8/D2: settlement energy intervals
//   PUT /api/v1/devices/:id/ems-plan v9 Contract A: push an EMS plan (upsert)
//   GET /api/v1/devices/:id/ems-plan v9 Contract A: active/next EMS plan
//   GET /api/v1/alarms[?status=]     alarms (default: active)
//
// Auth: `Authorization: Bearer etk_...` with a non-revoked key. Keys are
// managed via the tRPC apiKeys router (admin) — see docs/api-v1.md.
import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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

// ─── v9 Contract A: EMS plans (VoltTrade ERP optimizer → VoltTrade Cloud execution) ────
// A plan is a time-boxed step-function setpoint series for one BESS meter.
// Sign convention: kw > 0 = discharge, kw < 0 = charge, 0 = idle (matches the
// control-register semantics "+ = discharge"). validFrom/validTo are ISO8601;
// they are stored UTC-naive (project convention — always via utcStr, never
// through driver Date serialization which follows the host timezone).
const PLAN_MAX_SPAN_MS = 48 * 3_600_000;
const PLAN_MAX_SETPOINTS = 192;
const PLAN_MAX_ABS_KW = 500;

const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

interface PlanSetpoint {
  ts: string;
  kw: number;
}

interface PlanRow {
  id: number;
  meterId: number;
  orgId: number;
  source: string;
  validFrom: string;
  validTo: string;
  setpoints: PlanSetpoint[] | string;
  status: string;
  createdAt: string;
}

const PLAN_COLS = sql`id, meter_id as meterId, org_id as orgId, source,
  date_format(valid_from, '%Y-%m-%dT%H:%i:%sZ') as validFrom,
  date_format(valid_to, '%Y-%m-%dT%H:%i:%sZ') as validTo,
  setpoints, status,
  date_format(created_at, '%Y-%m-%dT%H:%i:%sZ') as createdAt`;

function normalizePlan(row: PlanRow) {
  return {
    ...row,
    setpoints: typeof row.setpoints === "string" ? JSON.parse(row.setpoints) : row.setpoints,
  };
}

restV1.put("/devices/:id/ems-plan", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid device id" }, 400);
  const org = c.get("apiKey").orgId ?? -1;
  const db = getDb();
  const dev = await db
    .select({ id: meters.id })
    .from(meters)
    .where(and(eq(meters.id, id), eq(meters.orgId, org)))
    .limit(1);
  if (dev.length === 0) return c.json({ error: "device not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "a JSON body is required" }, 400);
  }
  const b = body as { validFrom?: unknown; validTo?: unknown; source?: unknown; setpoints?: unknown };
  const fromMs = typeof b.validFrom === "string" ? Date.parse(b.validFrom) : NaN;
  const toMs = typeof b.validTo === "string" ? Date.parse(b.validTo) : NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return c.json({ error: "validFrom and validTo (ISO8601) are required" }, 400);
  }
  if (toMs <= fromMs) return c.json({ error: "validTo must be after validFrom" }, 400);
  if (toMs - fromMs > PLAN_MAX_SPAN_MS) return c.json({ error: "plan span must not exceed 48h" }, 400);
  let source = "unknown";
  if (b.source !== undefined) {
    if (typeof b.source !== "string" || b.source.length === 0 || b.source.length > 64) {
      return c.json({ error: "source must be a string of at most 64 characters" }, 400);
    }
    source = b.source;
  }
  if (!Array.isArray(b.setpoints) || b.setpoints.length < 1 || b.setpoints.length > PLAN_MAX_SETPOINTS) {
    return c.json({ error: `setpoints must be an array of 1..${PLAN_MAX_SETPOINTS} entries` }, 400);
  }
  const setpoints: PlanSetpoint[] = [];
  let prevMs = -Infinity;
  for (const raw of b.setpoints as Array<{ ts?: unknown; kw?: unknown }>) {
    const tsMs = raw && typeof raw.ts === "string" ? Date.parse(raw.ts) : NaN;
    const kw = raw && typeof raw.kw === "number" ? raw.kw : NaN;
    if (!Number.isFinite(tsMs)) return c.json({ error: "every setpoint needs an ISO8601 ts" }, 400);
    if (!Number.isFinite(kw) || Math.abs(kw) > PLAN_MAX_ABS_KW) {
      return c.json({ error: `every setpoint kw must be finite with |kw| <= ${PLAN_MAX_ABS_KW}` }, 400);
    }
    if (tsMs < prevMs) return c.json({ error: "setpoints must be sorted non-descending by ts" }, 400);
    if (tsMs < fromMs || tsMs > toMs) return c.json({ error: "every setpoint ts must lie within [validFrom, validTo]" }, 400);
    prevMs = tsMs;
    setpoints.push({ ts: new Date(tsMs).toISOString(), kw });
  }

  // Upsert/supersede semantics: any active plan of this meter overlapping
  // [validFrom, validTo) is superseded, then the new plan is inserted active.
  const vf = utcStr(new Date(fromMs));
  const vt = utcStr(new Date(toMs));
  const sup = await db.execute(
    sql`update ems_plans set status = 'superseded' where meter_id = ${id} and status = 'active' and valid_from < ${vt} and valid_to > ${vf}`,
  );
  const superseded = Number((sup[0] as { affectedRows?: number }).affectedRows ?? 0);
  const ins = await db.execute(
    sql`insert into ems_plans (meter_id, org_id, source, valid_from, valid_to, setpoints, status) values (${id}, ${org}, ${source}, ${vf}, ${vt}, ${JSON.stringify(setpoints)}, 'active')`,
  );
  const planId = Number((ins[0] as { insertId?: number }).insertId ?? 0);
  return c.json({ planId, status: "active" as const, superseded }, 200);
});

restV1.get("/devices/:id/ems-plan", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid device id" }, 400);
  const org = c.get("apiKey").orgId ?? -1;
  const db = getDb();
  const dev = await db
    .select({ id: meters.id })
    .from(meters)
    .where(and(eq(meters.id, id), eq(meters.orgId, org)))
    .limit(1);
  if (dev.length === 0) return c.json({ error: "device not found" }, 404);

  const now = utcStr(new Date());
  // Active plan covering now (latest created_at wins — overlap is already
  // prevented by the supersede semantics), else the next upcoming active plan.
  const cur = await db.execute(
    sql`select ${PLAN_COLS} from ems_plans where meter_id = ${id} and status = 'active' and valid_from <= ${now} and valid_to >= ${now} order by created_at desc, id desc limit 1`,
  );
  let plan = (cur[0] as unknown as PlanRow[])[0] ?? null;
  if (!plan) {
    const next = await db.execute(
      sql`select ${PLAN_COLS} from ems_plans where meter_id = ${id} and status = 'active' and valid_from > ${now} order by valid_from asc, id asc limit 1`,
    );
    plan = (next[0] as unknown as PlanRow[])[0] ?? null;
  }
  return c.json({ plan: plan ? normalizePlan(plan) : null });
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
