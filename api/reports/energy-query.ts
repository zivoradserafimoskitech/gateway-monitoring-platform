// Shared energy-report query — used by the tRPC reports router (interactive
// UI) and the v8/D3 scheduled-report generator (xlsx/pdf). Scope "site" also
// covers the fleet-wide case (siteId null = all sites).
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { gateways, meters, sites } from "@db/schema";
import type { Meter } from "@db/schema";
import { getTelemetryStore } from "../telemetry";
import { localDayRanges } from "../lib/tz";
import type { DailyReportRow } from "../telemetry/types";

export interface EnergyReportMeter {
  meter: Meter;
  days: DailyReportRow[];
  totalImportKwh: number;
  totalExportKwh: number;
  maxDemandKw: number;
}

export interface EnergyReport {
  scope: "meter" | "site";
  scopeLabel: string;
  from: Date;
  to: Date;
  meters: EnergyReportMeter[];
  totalImportKwh: number;
  totalExportKwh: number;
}

export async function queryEnergyReport(input: {
  scope: "meter" | "site";
  meterId?: number;
  siteId?: number; // site scope: null/undefined = all sites (fleet report)
  from: Date;
  to: Date;
  // v8/D2: when set (non-superadmin caller), only this org's devices contribute.
  orgId?: number;
}): Promise<EnergyReport> {
  const db = getDb();
  let meterFilter: number[] = [];
  let scopeLabel = "";
  let siteTz: string | null = null;
  const orgCond = input.orgId === undefined ? undefined : eq(meters.orgId, input.orgId);

  if (input.scope === "meter") {
    if (!input.meterId) throw new Error("meterId is required for meter scope");
    const m = await db.select().from(meters).where(eq(meters.id, input.meterId)).limit(1);
    if (!m[0]) throw new Error("Meter not found");
    if (input.orgId !== undefined && m[0].orgId !== input.orgId) throw new Error("Meter not found");
    meterFilter = [input.meterId];
    scopeLabel = m[0].name;
  } else if (input.siteId != null) {
    const s = await db.select().from(sites).where(eq(sites.id, input.siteId)).limit(1);
    if (!s[0]) throw new Error("Site not found");
    if (input.orgId !== undefined && s[0].orgId !== input.orgId) throw new Error("Site not found");
    siteTz = s[0].timezone ?? "UTC";
    // v6/R7: a device belongs to the site either directly (meters.site_id,
    // used by direct Modbus-TCP devices) or via its gateway.
    const rows = await db
      .select({ id: meters.id })
      .from(meters)
      .innerJoin(gateways, eq(meters.gatewayId, gateways.id))
      .where(and(sql`${meters.siteId} = ${input.siteId} or ${gateways.siteId} = ${input.siteId}`, orgCond));
    meterFilter = rows.map((r) => r.id);
    scopeLabel = s[0].name;
  } else {
    // Fleet scope (scheduled reports with siteId null = all sites).
    const rows = await db.select({ id: meters.id }).from(meters).where(orgCond);
    meterFilter = rows.map((r) => r.id);
    scopeLabel = input.orgId === undefined ? "All sites" : "All sites (org)";
  }

  // #18: one metadata query for ALL meters (was N+1), daily series in
  // parallel instead of serial per meter.
  // v7/C8: site-scope reports bucket days at the site's LOCAL midnight
  // (DST-correct ranges); meter-scope stays UTC.
  const dayBuckets =
    input.scope === "site" && siteTz && siteTz !== "UTC" ? localDayRanges(siteTz, input.from, input.to) : undefined;

  const meterRows = meterFilter.length ? await db.select().from(meters).where(inArray(meters.id, meterFilter)) : [];
  const byId = new Map(meterRows.map((m) => [m.id, m]));
  const perMeter = await Promise.all(
    meterFilter.map(async (id) => {
      const days = await getTelemetryStore().dailyReport(id, input.from, input.to, { dayBuckets });
      const totalImport = days.reduce((s, d) => s + (d.importKwh ?? 0), 0);
      const totalExport = days.reduce((s, d) => s + (d.exportKwh ?? 0), 0);
      const maxDemand = days.reduce((s, d) => Math.max(s, d.maxDemandKw ?? 0), 0);
      return {
        meter: byId.get(id)!,
        days,
        totalImportKwh: Math.round(totalImport * 100) / 100,
        totalExportKwh: Math.round(totalExport * 100) / 100,
        maxDemandKw: Math.round(maxDemand * 100) / 100,
      };
    }),
  );

  return {
    scope: input.scope,
    scopeLabel,
    from: input.from,
    to: input.to,
    meters: perMeter,
    totalImportKwh: Math.round(perMeter.reduce((s, m) => s + m.totalImportKwh, 0) * 100) / 100,
    totalExportKwh: Math.round(perMeter.reduce((s, m) => s + m.totalExportKwh, 0) * 100) / 100,
  };
}
