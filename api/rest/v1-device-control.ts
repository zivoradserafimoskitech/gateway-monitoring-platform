// Device control surface of the public REST API (Gateway Monitoring Platform).
//
// This is the endpoint VoltTrade's plant-connect function forwards to. The
// gateway stays the ONLY thing that touches plant: a command names a
// whitelisted controllable key from the device profile (never a raw register
// address), and goes through executeAndLog — the same chokepoint as manual
// control — so the emergency stop, verification gate, range check and audit
// trail all apply. The result carries the read-back outcome:
//   200 status "ok"     written and verified by read-back (direct TCP)
//   202 status "sent"   written via gateway downlink, read-back pending;
//                       poll GET /commands/:id or subscribe to command.confirmed
//   409 status "rejected" refused by a safety gate (estop, unverified, range)
//   502 status "failed" write or read-back failed
import type { Hono } from "hono";
import { and, desc, eq, like } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { commands, gateways, meters } from "@db/schema";
import type { Meter } from "@db/schema";
import { ControlError, controllableForModel, executeAndLog, executeControl, verificationForModel } from "../control/execute";
import { choosePlan, externalPlanMaxAgeMs, localOptimizerMode } from "../ems/plan-source";
import type { Vars } from "./v1";

const KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

async function orgMeter(id: number, org: number): Promise<Meter | null> {
  const rows = await getDb()
    .select()
    .from(meters)
    .where(and(eq(meters.id, id), eq(meters.orgId, org)))
    .limit(1);
  return rows[0] ?? null;
}

export interface CommandBody {
  key: string;
  value: number;
  externalId: string | null;
  dryRun: boolean;
}

/** Validate a command body. Accepts `key` or VoltTrade's `point` alias. */
export function parseCommandBody(raw: unknown): CommandBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "a JSON body is required" };
  const b = raw as Record<string, unknown>;
  const key = typeof b.key === "string" ? b.key : typeof b.point === "string" ? b.point : null;
  if (!key || !KEY_RE.test(key)) return { error: "key (or point) must be a controllable key of the device profile" };
  if (typeof b.value !== "number" || !Number.isFinite(b.value)) return { error: "value must be a finite number" };
  // Any `address` field (VoltTrade sends its own map for display) is ignored:
  // the register always comes from the verified device profile.
  let externalId: string | null = null;
  const ext = b.externalId ?? b.commandId;
  if (ext !== undefined && ext !== null) {
    if ((typeof ext !== "string" && typeof ext !== "number") || String(ext).length > 64) {
      return { error: "externalId must be a string or number of at most 64 characters" };
    }
    externalId = String(ext);
  }
  return { key, value: b.value, externalId, dryRun: b.dryRun === true };
}

export function httpStatusFor(status: string): 200 | 202 | 409 | 502 {
  if (status === "ok" || status === "preview") return 200;
  if (status === "sent") return 202;
  if (status === "rejected") return 409;
  return 502;
}

export function registerDeviceControlRoutes(app: Hono<Vars>): void {
  app.post("/devices/:id/commands", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid device id" }, 400);
    const apiKey = c.get("apiKey");
    const meter = await orgMeter(id, apiKey.orgId ?? -1);
    if (!meter) return c.json({ error: "device not found" }, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "a JSON body is required" }, 400);
    }
    const body = parseCommandBody(raw);
    if ("error" in body) return c.json(body, 400);
    try {
      if (body.dryRun) {
        const r = await executeControl(meter, body.key, body.value, { dryRun: true });
        return c.json({ commandId: null, externalId: body.externalId, status: r.status, detail: r.detail }, 200);
      }
      const r = await executeAndLog(meter, body.key, body.value, null);
      // Attribute the audit row to the API key + external id.
      if (r.commandId !== undefined) {
        const tag = `api:${apiKey.name}${body.externalId ? ` ext:${body.externalId}` : ""}`;
        await getDb()
          .update(commands)
          .set({ topic: `control:${meter.model}|${tag}`.slice(0, 255) })
          .where(eq(commands.id, r.commandId));
      }
      return c.json(
        {
          commandId: r.commandId ?? null,
          externalId: body.externalId,
          status: r.status,
          detail: r.detail,
          readback: r.status === "ok" ? "verified" : r.status === "sent" ? "pending" : "failed",
        },
        httpStatusFor(r.status),
      );
    } catch (e) {
      if (e instanceof ControlError) {
        return c.json({ commandId: null, externalId: body.externalId, status: "rejected", detail: e.message }, 409);
      }
      throw e;
    }
  });

  app.get("/commands/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid command id" }, 400);
    const org = c.get("apiKey").orgId ?? -1;
    const rows = await getDb()
      .select({
        id: commands.id,
        meterId: commands.meterId,
        gatewayId: commands.gatewayId,
        kind: commands.kind,
        key: commands.controlKey,
        value: commands.controlValue,
        status: commands.status,
        result: commands.result,
        topic: commands.topic,
        createdAt: commands.createdAt,
        respondedAt: commands.respondedAt,
      })
      .from(commands)
      .innerJoin(meters, eq(meters.id, commands.meterId))
      .where(and(eq(commands.id, id), eq(meters.orgId, org)))
      .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: "command not found" }, 404);
    const ext = /ext:(\S+)/.exec(row.topic)?.[1] ?? null;
    return c.json({
      command: {
        ...row,
        topic: undefined,
        externalId: ext,
        readback: row.status === "ok" ? "verified" : row.status === "sent" ? "pending" : "failed",
      },
    });
  });

  app.get("/devices/:id/capabilities", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid device id" }, 400);
    const meter = await orgMeter(id, c.get("apiKey").orgId ?? -1);
    if (!meter) return c.json({ error: "device not found" }, 404);
    const [controllable, verification, gw] = await Promise.all([
      controllableForModel(meter.model),
      verificationForModel(meter.model),
      getDb().select({ transport: gateways.transport, model: gateways.model }).from(gateways).where(eq(gateways.id, meter.gatewayId)).limit(1),
    ]);
    const path = meter.host ? "direct-tcp" : gw[0]?.transport === "transparent" ? "gateway-downlink" : "none";
    const verified = verification === null || verification.verificationStatus !== "draft" || verification.allowUnverifiedControl;
    return c.json({
      deviceId: meter.id,
      model: meter.model,
      controlPath: path,
      controlEnabled: path !== "none" && verified && Object.keys(controllable).length > 0,
      profileVerification: verification?.verificationStatus ?? "verified",
      readback: path === "direct-tcp" ? "synchronous" : path === "gateway-downlink" ? "asynchronous" : "none",
      controllable: Object.entries(controllable).map(([key, d]) => ({ key, min: d.min, max: d.max, unit: d.unit ?? null })),
      emsPlan: { accepted: true, localOptimizer: localOptimizerMode(), externalPlanMaxAgeMin: externalPlanMaxAgeMs() / 60_000 },
    });
  });

  app.get("/devices/:id/plan-execution", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid device id" }, 400);
    const meter = await orgMeter(id, c.get("apiKey").orgId ?? -1);
    if (!meter) return c.json({ error: "device not found" }, 404);
    const { emsPlans } = await import("@db/schema");
    const { lte, gte } = await import("drizzle-orm");
    const now = new Date();
    const db = getDb();
    const active = await db
      .select({ id: emsPlans.id, source: emsPlans.source, createdAt: emsPlans.createdAt, validFrom: emsPlans.validFrom, validTo: emsPlans.validTo })
      .from(emsPlans)
      .where(and(eq(emsPlans.meterId, id), eq(emsPlans.status, "active"), lte(emsPlans.validFrom, now), gte(emsPlans.validTo, now)))
      .orderBy(desc(emsPlans.createdAt), desc(emsPlans.id));
    const inForce = choosePlan(active, now.getTime(), externalPlanMaxAgeMs());
    const recent = await db
      .select({ id: commands.id, key: commands.controlKey, value: commands.controlValue, status: commands.status, result: commands.result, createdAt: commands.createdAt })
      .from(commands)
      .where(and(eq(commands.meterId, id), like(commands.result, "plan:%")))
      .orderBy(desc(commands.id))
      .limit(50);
    return c.json({
      deviceId: id,
      planInForce: inForce ? { ...inForce, origin: inForce.source === "tariff-optimizer" ? "local-fallback" : "external" } : null,
      candidates: active.length,
      recentWrites: recent,
    });
  });
}
