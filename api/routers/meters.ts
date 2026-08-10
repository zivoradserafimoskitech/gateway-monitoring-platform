import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { meters, gateways, telemetry, sites, alarms, deviceProfiles } from "@db/schema";
import { DEFAULT_METER_PHASES } from "@contracts/modbus";
import { DEVICE_TYPES, PRIMARY_POWER_KEY } from "@contracts/devices";
import type { DeviceType } from "@contracts/devices";
import { getTelemetryStore } from "../telemetry";
import { testTcpConnection } from "../poller/test-connection";
import { clearMeterCache } from "../mqtt/handlers";

// Direct Modbus-TCP devices have no physical gateway; they hang off this
// system row so foreign keys and fleet queries keep working unchanged.
const DIRECT_GATEWAY_UID = "direct-tcp";

// v6/R7: two site joins — meter's own binding and the gateway's.
const gwSite = alias(sites, "gw_site");
const metersSite = alias(sites, "meters_site");

async function getOrCreateDirectGateway(): Promise<number> {
  const db = getDb();
  const existing = await db.select().from(gateways).where(eq(gateways.uid, DIRECT_GATEWAY_UID)).limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(gateways)
    .values({
      uid: DIRECT_GATEWAY_UID,
      name: "Direct Modbus TCP (poller)",
      model: "TCP",
      transport: "tcp",
      topicPrefix: "-",
      status: "online",
    })
    .$returningId();
  return inserted[0].id;
}

export const metersRouter = createRouter({
  list: authed.query(async () => {
    const db = getDb();
    // v6/R7: effective site = meter's own binding first, else the gateway's.
    const rows = await db
      .select({ meter: meters, gatewayName: gateways.name, gatewayUid: gateways.uid, siteName: sql<string | null>`coalesce(${metersSite.name}, ${gwSite.name})` })
      .from(meters)
      .leftJoin(gateways, eq(meters.gatewayId, gateways.id))
      .leftJoin(gwSite, eq(gateways.siteId, gwSite.id))
      .leftJoin(metersSite, eq(meters.siteId, metersSite.id))
      .orderBy(desc(meters.createdAt));
    return rows.map((r) => ({
      ...r.meter,
      gatewayName: r.gatewayName,
      gatewayUid: r.gatewayUid,
      siteName: r.siteName,
    }));
  }),

  create: operator
    .input(
      z.object({
        gatewayId: z.number().optional(), // omitted for direct-TCP devices
        siteId: z.number().optional().nullable(), // v6/R7: plant binding for direct-TCP devices
        name: z.string().min(1).max(255),
        model: z.string().min(1).max(128),
        deviceType: z.enum(DEVICE_TYPES).default("meter"),
        brand: z.string().max(64).optional(),
        modbusAddress: z.number().int().min(1).max(247).default(1), // bus address (RTU)
        channel: z.number().int().min(1).max(2).default(1),
        // v6/R5: IPv4 or DNS hostname — anything else is guaranteed to fail at
        // poll time, so reject it at registration.
        host: z
          .string()
          .trim()
          .max(255)
          .regex(
            /^(([0-9]{1,3}\.){3}[0-9]{1,3}|([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}|[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)$/,
            "Host must be an IPv4 address or a valid DNS hostname",
          )
          .optional(),
        port: z.number().int().min(1).max(65535).optional(),
        unitId: z.number().int().min(0).max(255).optional(),
        pollIntervalSec: z.number().int().min(5).max(3600).default(60),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const isTcp = !!input.host;
      const gatewayId = input.gatewayId ?? (await getOrCreateDirectGateway());

      // v6/R4: the model must match a device profile — otherwise the poller
      // and MQTT decode silently fall back to the PEM3000 default map and
      // persist wrong values with no error anywhere.
      const profile = await db
        .select({ model: deviceProfiles.model })
        .from(deviceProfiles)
        .where(eq(deviceProfiles.model, input.model))
        .limit(1);
      if (!profile[0]) {
        throw new Error(
          `Unknown model "${input.model}" — it must match an existing device profile (Settings → Device profiles)`,
        );
      }
      // v6/R7: validate the site exists when explicitly bound.
      if (input.siteId != null) {
        const s = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
        if (!s[0]) throw new Error("Site not found");
      }

      let modbusAddress = input.modbusAddress;
      if (isTcp) {
        // Real unit ID lives in unitId; modbusAddress is a synthetic unique slot
        const dup = await db
          .select()
          .from(meters)
          .where(
            and(
              eq(meters.host, input.host!),
              eq(meters.port, input.port ?? 502),
              eq(meters.unitId, input.unitId ?? 1),
            ),
          )
          .limit(1);
        if (dup[0]) throw new Error("A device with this host:port:unit already exists");
        const slot = await db
          .select({ addr: meters.modbusAddress })
          .from(meters)
          .where(eq(meters.gatewayId, gatewayId))
          .orderBy(desc(meters.modbusAddress))
          .limit(1);
        modbusAddress = (slot[0]?.addr ?? 0) + 1;
      } else {
        const dup = await db
          .select()
          .from(meters)
          .where(and(eq(meters.gatewayId, gatewayId), eq(meters.modbusAddress, modbusAddress)))
          .limit(1);
        if (dup[0]) throw new Error("A device with this Modbus address already exists on the gateway");
      }

      const inserted = await db
        .insert(meters)
        .values({
          gatewayId,
          siteId: input.siteId ?? null,
          name: input.name,
          model: input.model,
          deviceType: input.deviceType,
          brand: input.brand ?? null,
          phases: (DEFAULT_METER_PHASES as Record<string, "single" | "three">)[input.model] ?? "three",
          modbusAddress,
          channel: input.channel,
          host: input.host ?? null,
          port: input.host ? (input.port ?? 502) : null,
          unitId: input.host ? (input.unitId ?? 1) : null,
          pollIntervalSec: input.pollIntervalSec,
        })
        .$returningId();
      const rows = await db.select().from(meters).where(eq(meters.id, inserted[0].id)).limit(1);
      return rows[0];
    }),

  // v7/C4: probe a device before saving it. TCP → real register read on a
  // throwaway socket. Bus → gateway liveness check (MQTT uplinks are async, a
  // synchronous read isn't possible before the device exists).
  testConnection: operator
    .input(
      z.object({
        model: z.string().min(1).max(128),
        host: z.string().max(255).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        unitId: z.number().int().min(0).max(255).optional(),
        gatewayId: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.host) {
        return testTcpConnection(input.model, input.host, input.port ?? 502, input.unitId ?? 1);
      }
      if (input.gatewayId) {
        const db = getDb();
        const gw = await db.select().from(gateways).where(eq(gateways.id, input.gatewayId)).limit(1);
        if (!gw[0]) return { ok: false, ms: 0, error: "Gateway not found" };
        const online = gw[0].status === "online";
        return {
          ok: online,
          ms: 0,
          error: online
            ? undefined
            : "Gateway is offline — bus devices can only be verified once the gateway publishes",
        };
      }
      return { ok: false, ms: 0, error: "host or gatewayId required" };
    }),

  update: operator
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        model: z.string().min(1).max(128).optional(),
        deviceType: z.enum(DEVICE_TYPES).optional(),
        brand: z.string().max(64).nullable().optional(),
        siteId: z.number().nullable().optional(), // v6/R7
        modbusAddress: z.number().int().min(1).max(247).optional(),
        channel: z.number().int().min(1).max(2).optional(),
        host: z
          .string()
          .trim()
          .max(255)
          .regex(
            /^(([0-9]{1,3}\.){3}[0-9]{1,3}|([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}|[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)$/,
            "Host must be an IPv4 address or a valid DNS hostname",
          )
          .nullable()
          .optional(),
        port: z.number().int().min(1).max(65535).nullable().optional(),
        unitId: z.number().int().min(0).max(255).nullable().optional(),
        pollIntervalSec: z.number().int().min(5).max(3600).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...patch } = input;
      if (patch.model) {
        // v6/R4: same profile-exists rule as create.
        const profile = await db
          .select({ model: deviceProfiles.model })
          .from(deviceProfiles)
          .where(eq(deviceProfiles.model, patch.model))
          .limit(1);
        if (!profile[0]) {
          throw new Error(
            `Unknown model "${patch.model}" — it must match an existing device profile (Settings → Device profiles)`,
          );
        }
        (patch as Record<string, unknown>).phases =
          (DEFAULT_METER_PHASES as Record<string, "single" | "three">)[patch.model] ?? "three";
      }
      if (patch.siteId != null) {
        const s = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, patch.siteId)).limit(1);
        if (!s[0]) throw new Error("Site not found");
      }
      await db.update(meters).set(patch).where(eq(meters.id, id));
      const rows = await db.select().from(meters).where(eq(meters.id, id)).limit(1);
      return rows[0];
    }),

  remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    // Cascade (v4 review #1): telemetry AND alarms, or they orphan forever.
    await db.delete(telemetry).where(eq(telemetry.meterId, input.id));
    await db.delete(alarms).where(eq(alarms.meterId, input.id));
    await db.delete(meters).where(eq(meters.id, input.id));
    clearMeterCache(); // #16: ingestion cache must not serve the deleted row
    return { ok: true };
  }),

  latest: authed.input(z.object({ meterId: z.number() })).query(async ({ input }) => {
    const row = await getTelemetryStore().latest(input.meterId);
    if (!row) return null;
    // Shape-compatible with the old telemetry table row the frontend expects,
    // plus the full open values map for device-specific rendering.
    return {
      meterId: row.meterId,
      ts: row.ts,
      values: row.values,
      voltageL1: row.values.voltageL1 ?? null,
      voltageL2: row.values.voltageL2 ?? null,
      voltageL3: row.values.voltageL3 ?? null,
      currentL1: row.values.currentL1 ?? null,
      currentL2: row.values.currentL2 ?? null,
      currentL3: row.values.currentL3 ?? null,
      activePowerKw: row.values.activePowerKw ?? null,
      reactivePowerKvar: row.values.reactivePowerKvar ?? null,
      apparentPowerKva: row.values.apparentPowerKva ?? null,
      powerFactor: row.values.powerFactor ?? null,
      frequencyHz: row.values.frequencyHz ?? null,
      energyImportKwh: row.values.energyImportKwh ?? null,
      energyExportKwh: row.values.energyExportKwh ?? null,
      demandKw: row.values.demandKw ?? null,
    };
  }),

  history: authed
    .input(
      z.object({
        meterId: z.number(),
        from: z.date(),
        to: z.date(),
        buckets: z.number().int().min(10).max(500).default(120),
      }),
    )
    .query(async ({ input }) => {
      const spanSec = Math.max(60, Math.floor((input.to.getTime() - input.from.getTime()) / 1000));
      const bucketSec = Math.max(10, Math.floor(spanSec / input.buckets));
      // #20: chart series follows the device's PRIMARY_POWER_KEY contract
      // (BESS → batteryPowerKw), not a hardcoded activePowerKw.
      const db = getDb();
      const m = await db
        .select({ deviceType: meters.deviceType })
        .from(meters)
        .where(eq(meters.id, input.meterId))
        .limit(1);
      const dt = (m[0]?.deviceType ?? "meter") as DeviceType;
      const powerKey = PRIMARY_POWER_KEY[dt] ?? "activePowerKw";
      return getTelemetryStore().history(input.meterId, input.from, input.to, bucketSec, powerKey);
    }),
});
