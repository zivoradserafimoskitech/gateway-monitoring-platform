// v8/D1: EMS tRPC — operator-guarded CRUD for BESS schedules and peak-shaving
// configs; any authenticated user can read the recent automatic command feed
// (system commands: kind=control, userId null). Mutation audit rows come free
// via the RBAC middleware.
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import {
  batteryCapacityEstimates,
  batteryEconomics,
  batteryHealth,
  commands,
  curtailmentAssets,
  emsPeakShaving,
  emsPlans,
  emsSchedules,
  gridLimits,
  meters,
  sites,
  tariffPeriods,
  tariffPrices,
  tariffs,
} from "@db/schema";
import { assertOrgRead, assertOrgWrite, isSuper, meterOrg, orgWhere, siteOrg, stampOrg } from "../lib/org-scope";
import { optimizeBattery } from "../ems/optimizer";
import type { User } from "@db/schema";

async function assertMeter(id: number): Promise<void> {
  const rows = await getDb().select({ id: meters.id }).from(meters).where(eq(meters.id, id)).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${id} not found` });
}

/** v8/D2: schedule/config rows carry org_id — mutation guard (404/403). */
async function assertRowOrg(user: User | null, table: "schedules" | "peak", id: number): Promise<void> {
  const db = getDb();
  const rows =
    table === "schedules"
      ? await db.select({ orgId: emsSchedules.orgId }).from(emsSchedules).where(eq(emsSchedules.id, id)).limit(1)
      : await db.select({ orgId: emsPeakShaving.orgId }).from(emsPeakShaving).where(eq(emsPeakShaving.id, id)).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `${table === "schedules" ? "Schedule" : "Config"} ${id} not found` });
  assertOrgWrite(user, rows[0].orgId, "Row");
}

/** Org-owned meter ids for scoping the auto-command feed (commands has no org_id). */
async function orgMeterIds(user: User | null): Promise<number[] | undefined> {
  if (isSuper(user)) return undefined;
  const rows = await getDb().select({ id: meters.id }).from(meters).where(eq(meters.orgId, user!.orgId ?? -1));
  return rows.map((r) => r.id);
}

const minutes = z.number().int().min(0).max(1440);

const scheduleInput = z.object({
  meterId: z.number(),
  name: z.string().min(1).max(255),
  dayOfWeekMask: z.number().int().min(1).max(127),
  startMin: minutes,
  endMin: minutes,
  mode: z.enum(["charge", "discharge", "idle"]),
  targetKw: z.number().finite().min(0).nullable().optional(),
  targetSoc: z.number().finite().min(0).max(100).nullable().optional(),
  enabled: z.boolean().optional(),
});

const peakInput = z.object({
  siteId: z.number().nullable().optional(),
  sourceMeterId: z.number(),
  bessMeterId: z.number(),
  thresholdKw: z.number().finite().min(0),
  hysteresisKw: z.number().finite().min(0).optional(),
  maxDischargeKw: z.number().finite().positive(),
  enabled: z.boolean().optional(),
});

// §9.2: a connection limit is a positive magnitude in both directions —
// "export at most 100 kW" — so the sign convention never reaches the operator.
const gridLimitInput = z.object({
  siteId: z.number(),
  pccMeterId: z.number(),
  maxImportKw: z.number().finite().min(0).nullable().optional(),
  maxExportKw: z.number().finite().min(0).nullable().optional(),
  deadbandKw: z.number().finite().min(0).optional(),
  // A zero step would freeze the controller at whatever it currently holds.
  maxStepKw: z.number().finite().positive().optional(),
  enabled: z.boolean().optional(),
});

const assetInput = z.object({
  siteId: z.number(),
  meterId: z.number(),
  priority: z.number().int().min(0).max(10_000).optional(),
  ratedKw: z.number().finite().positive(),
  enabled: z.boolean().optional(),
});

export const emsRouter = createRouter({
  schedules: createRouter({
    list: authed.input(z.object({ meterId: z.number().optional() })).query(async ({ input, ctx }) => {
      const db = getDb();
      const conds = [orgWhere(ctx.user, emsSchedules.orgId), input.meterId != null ? eq(emsSchedules.meterId, input.meterId) : undefined].filter(
        (c) => c !== undefined,
      );
      return db
        .select()
        .from(emsSchedules)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(emsSchedules.id);
    }),

    create: operator.input(scheduleInput).mutation(async ({ input, ctx }) => {
      await assertMeter(input.meterId);
      assertOrgWrite(ctx.user, await meterOrg(input.meterId), "Device");
      const db = getDb();
      const res = await db.insert(emsSchedules).values({ ...input, createdBy: ctx.user?.id ?? null, orgId: stampOrg(ctx.user) }).$returningId();
      return { id: res[0].id };
    }),

    update: operator
      .input(z.object({ id: z.number(), patch: scheduleInput.partial().omit({ meterId: true }) }))
      .mutation(async ({ input, ctx }) => {
        await assertRowOrg(ctx.user, "schedules", input.id);
        const db = getDb();
        const res = await db.update(emsSchedules).set(input.patch).where(eq(emsSchedules.id, input.id));
        if ((res[0] as { affectedRows?: number }).affectedRows === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Schedule ${input.id} not found` });
        }
        return { ok: true };
      }),

    remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
      await assertRowOrg(ctx.user, "schedules", input.id);
      const db = getDb();
      await db.delete(emsSchedules).where(eq(emsSchedules.id, input.id));
      return { ok: true };
    }),
  }),

  peakShaving: createRouter({
    list: authed
      .input(z.object({ bessMeterId: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        const db = getDb();
        const conds = [orgWhere(ctx.user, emsPeakShaving.orgId), input.bessMeterId != null ? eq(emsPeakShaving.bessMeterId, input.bessMeterId) : undefined].filter(
          (c) => c !== undefined,
        );
        return db
          .select()
          .from(emsPeakShaving)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(emsPeakShaving.id);
      }),

    create: operator.input(peakInput).mutation(async ({ input, ctx }) => {
      await assertMeter(input.sourceMeterId);
      await assertMeter(input.bessMeterId);
      assertOrgWrite(ctx.user, await meterOrg(input.sourceMeterId), "Device");
      assertOrgWrite(ctx.user, await meterOrg(input.bessMeterId), "Device");
      const db = getDb();
      const res = await db.insert(emsPeakShaving).values({ ...input, orgId: stampOrg(ctx.user) }).$returningId();
      return { id: res[0].id };
    }),

    update: operator
      .input(z.object({ id: z.number(), patch: peakInput.partial() }))
      .mutation(async ({ input, ctx }) => {
        await assertRowOrg(ctx.user, "peak", input.id);
        const db = getDb();
        const res = await db.update(emsPeakShaving).set(input.patch).where(eq(emsPeakShaving.id, input.id));
        if ((res[0] as { affectedRows?: number }).affectedRows === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Peak-shaving config ${input.id} not found` });
        }
        return { ok: true };
      }),

    remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
      await assertRowOrg(ctx.user, "peak", input.id);
      const db = getDb();
      await db.delete(emsPeakShaving).where(eq(emsPeakShaving.id, input.id));
      return { ok: true };
    }),
  }),

  // §9.2: the site's grid connection limit and the assets that may be curtailed
  // to hold it. One limit row per site; the EMS tick reads both every pass.
  gridLimits: createRouter({
    list: authed.query(async ({ ctx }) => {
      const db = getDb();
      const rows = await db
        .select({ limit: gridLimits, siteName: sites.name, pccName: meters.name })
        .from(gridLimits)
        .leftJoin(sites, eq(gridLimits.siteId, sites.id))
        .leftJoin(meters, eq(gridLimits.pccMeterId, meters.id))
        .where(orgWhere(ctx.user, gridLimits.orgId))
        .orderBy(gridLimits.siteId);
      return rows.map((r) => ({ ...r.limit, siteName: r.siteName, pccMeterName: r.pccName }));
    }),

    upsert: operator.input(gridLimitInput).mutation(async ({ input, ctx }) => {
      await assertMeter(input.pccMeterId);
      assertOrgWrite(ctx.user, await meterOrg(input.pccMeterId), "Device");
      assertOrgWrite(ctx.user, await siteOrg(input.siteId), "Site");
      if (input.maxImportKw == null && input.maxExportKw == null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Set at least one of the import or export limits — a limit row with neither does nothing",
        });
      }
      const db = getDb();
      const existing = await db
        .select({ id: gridLimits.id })
        .from(gridLimits)
        .where(eq(gridLimits.siteId, input.siteId))
        .limit(1);
      if (existing[0]) {
        await db.update(gridLimits).set(input).where(eq(gridLimits.id, existing[0].id));
        return { id: existing[0].id };
      }
      const res = await db.insert(gridLimits).values({ ...input, orgId: stampOrg(ctx.user) }).$returningId();
      return { id: res[0].id };
    }),

    remove: operator.input(z.object({ siteId: z.number() })).mutation(async ({ input, ctx }) => {
      assertOrgWrite(ctx.user, await siteOrg(input.siteId), "Site");
      const db = getDb();
      // The assets go with the limit: leaving them behind would make a future
      // limit on the same site silently inherit an old curtailment order.
      await db.delete(curtailmentAssets).where(eq(curtailmentAssets.siteId, input.siteId));
      await db.delete(gridLimits).where(eq(gridLimits.siteId, input.siteId));
      return { ok: true };
    }),

    assets: authed.input(z.object({ siteId: z.number() })).query(async ({ input, ctx }) => {
      assertOrgRead(ctx.user, await siteOrg(input.siteId), "Site");
      const db = getDb();
      const rows = await db
        .select({ asset: curtailmentAssets, meterName: meters.name, model: meters.model })
        .from(curtailmentAssets)
        .leftJoin(meters, eq(curtailmentAssets.meterId, meters.id))
        .where(eq(curtailmentAssets.siteId, input.siteId))
        .orderBy(asc(curtailmentAssets.priority));
      return rows.map((r) => ({ ...r.asset, meterName: r.meterName, model: r.model }));
    }),

    addAsset: operator.input(assetInput).mutation(async ({ input, ctx }) => {
      await assertMeter(input.meterId);
      assertOrgWrite(ctx.user, await meterOrg(input.meterId), "Device");
      assertOrgWrite(ctx.user, await siteOrg(input.siteId), "Site");
      const db = getDb();
      const dup = await db
        .select({ id: curtailmentAssets.id })
        .from(curtailmentAssets)
        .where(and(eq(curtailmentAssets.siteId, input.siteId), eq(curtailmentAssets.meterId, input.meterId)))
        .limit(1);
      if (dup[0]) throw new TRPCError({ code: "CONFLICT", message: "That device is already in the curtailment order" });
      const res = await db.insert(curtailmentAssets).values(input).$returningId();
      return { id: res[0].id };
    }),

    updateAsset: operator
      .input(z.object({ id: z.number(), patch: assetInput.partial().omit({ siteId: true, meterId: true }) }))
      .mutation(async ({ input, ctx }) => {
        const db = getDb();
        const rows = await db
          .select({ siteId: curtailmentAssets.siteId })
          .from(curtailmentAssets)
          .where(eq(curtailmentAssets.id, input.id))
          .limit(1);
        if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Curtailment asset not found" });
        assertOrgWrite(ctx.user, await siteOrg(rows[0].siteId), "Site");
        await db.update(curtailmentAssets).set(input.patch).where(eq(curtailmentAssets.id, input.id));
        return { ok: true };
      }),

    removeAsset: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
      const db = getDb();
      const rows = await db
        .select({ siteId: curtailmentAssets.siteId })
        .from(curtailmentAssets)
        .where(eq(curtailmentAssets.id, input.id))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Curtailment asset not found" });
      assertOrgWrite(ctx.user, await siteOrg(rows[0].siteId), "Site");
      await db.delete(curtailmentAssets).where(eq(curtailmentAssets.id, input.id));
      return { ok: true };
    }),
  }),

  // Recent automatic (system) commands — controller decisions land in the same
  // commands audit table as manual control, distinguishable by userId null.
  autoCommands: authed
    .input(z.object({ meterId: z.number().optional(), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      // v8/D2: commands has no org_id — scope through org-owned meter ids.
      const meterIds = await orgMeterIds(ctx.user);
      const where = and(
        eq(commands.kind, "control"),
        isNull(commands.userId),
        input.meterId != null ? eq(commands.meterId, input.meterId) : undefined,
        meterIds !== undefined ? (meterIds.length ? inArray(commands.meterId, meterIds) : eq(commands.meterId, -1)) : undefined,
      );
      return db
        .select({
          id: commands.id,
          meterId: commands.meterId,
          status: commands.status,
          controlKey: commands.controlKey,
          controlValue: commands.controlValue,
          result: commands.result,
          createdAt: commands.createdAt,
        })
        .from(commands)
        .where(where)
        .orderBy(desc(commands.createdAt))
        .limit(input.limit);
    }),

  // v9.1/B1: optimizer-pushed EMS plans (Contract A) — read-only UI access.
  // Org-scoped via emsPlans.org_id directly (plans carry org since 0013).
  plans: authed.input(z.object({ meterId: z.number(), limit: z.number().min(1).max(50).default(10) })).query(async ({ input, ctx }) => {
    const db = getDb();
    return db
      .select({
        id: emsPlans.id,
        meterId: emsPlans.meterId,
        source: emsPlans.source,
        validFrom: emsPlans.validFrom,
        validTo: emsPlans.validTo,
        setpoints: emsPlans.setpoints,
        status: emsPlans.status,
        createdAt: emsPlans.createdAt,
      })
      .from(emsPlans)
      .where(and(eq(emsPlans.meterId, input.meterId), orgWhere(ctx.user, emsPlans.orgId)))
      .orderBy(desc(emsPlans.validFrom))
      .limit(input.limit);
  }),

  // ─── §9.5: battery state of health ─────────────────────────────────────────
  // A BESS is the most expensive thing on most of these sites and the only one
  // that wears out by being used. Warranties are written in equivalent full
  // cycles and retained capacity; before this the platform could report
  // neither.
  health: createRouter({
    list: authed.query(async ({ ctx }) => {
      const db = getDb();
      const rows = await db
        .select({ health: batteryHealth, meterName: meters.name })
        .from(batteryHealth)
        .innerJoin(meters, eq(batteryHealth.meterId, meters.id))
        .where(orgWhere(ctx.user, batteryHealth.orgId))
        .orderBy(meters.name);
      return rows.map((r) => ({ ...r.health, meterName: r.meterName }));
    }),

    // The nameplate is a fact about the hardware, not something telemetry can
    // reveal, and every derived figure is a ratio against it — so it is the one
    // input a human must supply.
    setNameplate: operator
      .input(z.object({ meterId: z.number(), nameplateKwh: z.number().finite().positive().max(100_000).nullable() }))
      .mutation(async ({ ctx, input }) => {
        const org = await meterOrg(input.meterId);
        assertOrgWrite(ctx.user, org, "Device");
        const db = getDb();
        const existing = await db
          .select({ meterId: batteryHealth.meterId })
          .from(batteryHealth)
          .where(eq(batteryHealth.meterId, input.meterId))
          .limit(1);
        if (existing[0]) {
          await db
            .update(batteryHealth)
            .set({ nameplateKwh: input.nameplateKwh })
            .where(eq(batteryHealth.meterId, input.meterId));
        } else {
          await db
            .insert(batteryHealth)
            .values({ meterId: input.meterId, nameplateKwh: input.nameplateKwh, orgId: org ?? null });
        }
        return { ok: true };
      }),

    // The measurements behind the number. A single SoH figure with no working
    // behind it is not something an operator can take to a supplier, and a
    // warranty claim is exactly that argument.
    estimates: authed
      .input(z.object({ meterId: z.number(), limit: z.number().int().min(1).max(200).default(50) }))
      .query(async ({ ctx, input }) => {
        assertOrgRead(ctx.user, await meterOrg(input.meterId), "Device");
        return getDb()
          .select()
          .from(batteryCapacityEstimates)
          .where(eq(batteryCapacityEstimates.meterId, input.meterId))
          .orderBy(desc(batteryCapacityEstimates.endedAt))
          .limit(input.limit);
      }),
  }),

  // ─── §9.3: tariffs and tariff-aware planning ───────────────────────────────
  // The EMS could discharge on a schedule and shave a peak. Neither knows what
  // electricity costs, so the thing a battery is bought for on a commercial
  // site — buy cheap, use dear — had to be approximated by a human writing
  // time windows by hand and editing them whenever the contract changed.
  tariffs: createRouter({
    list: authed.query(async ({ ctx }) => {
      const db = getDb();
      const rows = await db
        .select({ tariff: tariffs, siteName: sites.name })
        .from(tariffs)
        .leftJoin(sites, eq(tariffs.siteId, sites.id))
        .where(orgWhere(ctx.user, tariffs.orgId))
        .orderBy(desc(tariffs.createdAt));
      // One query for every tariff's periods, not one per tariff.
      const ids = rows.map((r) => r.tariff.id);
      const periods = ids.length
        ? await db.select().from(tariffPeriods).where(inArray(tariffPeriods.tariffId, ids)).orderBy(asc(tariffPeriods.id))
        : [];
      const byTariff = new Map<number, typeof periods>();
      for (const p of periods) byTariff.set(p.tariffId, [...(byTariff.get(p.tariffId) ?? []), p]);
      return rows.map((r) => ({ ...r.tariff, siteName: r.siteName, periods: byTariff.get(r.tariff.id) ?? [] }));
    }),

    create: operator
      .input(
        z.object({
          name: z.string().min(1).max(255),
          siteId: z.number().nullable().optional(),
          currency: z.string().min(1).max(8).default("EUR"),
          timezone: z.string().min(1).max(64).default("UTC"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const siteGiven = input.siteId != null;
        const siteOrgId = input.siteId != null ? await siteOrg(input.siteId) : null;
        // undefined = no such site, which assertOrgWrite turns into a 404.
        if (siteGiven) assertOrgWrite(ctx.user, siteOrgId, "Site");
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
        } catch {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown timezone: ${input.timezone}` });
        }
        const inserted = await getDb()
          .insert(tariffs)
          .values({
            name: input.name,
            siteId: input.siteId ?? null,
            currency: input.currency,
            timezone: input.timezone,
            // A site's tariff belongs to the site's org. Stamped from the
            // caller instead, a superadmin creating one for a customer's site
            // filed it under their own org, and the optimiser — which only
            // reads the battery's org and global tariffs — never applied it.
            orgId: siteGiven ? (siteOrgId ?? null) : stampOrg(ctx.user, null),
          })
          .$returningId();
        return { id: inserted[0].id };
      }),

    remove: operator.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db.select({ orgId: tariffs.orgId }).from(tariffs).where(eq(tariffs.id, input.id)).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Tariff not found" });
      assertOrgWrite(ctx.user, rows[0].orgId, "Tariff");
      await db.delete(tariffPrices).where(eq(tariffPrices.tariffId, input.id));
      await db.delete(tariffPeriods).where(eq(tariffPeriods.tariffId, input.id));
      await db.delete(tariffs).where(eq(tariffs.id, input.id));
      return { ok: true };
    }),

    addPeriod: operator
      .input(
        z.object({
          tariffId: z.number(),
          label: z.string().max(64).optional(),
          dayOfWeekMask: z.number().int().min(1).max(127).default(127),
          startMin: z.number().int().min(0).max(1439).default(0),
          endMin: z.number().int().min(0).max(1439).default(0),
          importPrice: z.number().finite().min(0),
          // null, not 0: "export is not paid" and "export is paid nothing" are
          // the same number but not the same fact, and the optimiser treats
          // them differently.
          exportPrice: z.number().finite().min(0).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const db = getDb();
        const rows = await db.select({ orgId: tariffs.orgId }).from(tariffs).where(eq(tariffs.id, input.tariffId)).limit(1);
        if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Tariff not found" });
        assertOrgWrite(ctx.user, rows[0].orgId, "Tariff");
        const inserted = await db
          .insert(tariffPeriods)
          .values({
            tariffId: input.tariffId,
            label: input.label ?? null,
            dayOfWeekMask: input.dayOfWeekMask,
            startMin: input.startMin,
            endMin: input.endMin,
            importPrice: input.importPrice,
            exportPrice: input.exportPrice ?? null,
          })
          .$returningId();
        return { id: inserted[0].id };
      }),

    removePeriod: operator.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db
        .select({ orgId: tariffs.orgId })
        .from(tariffPeriods)
        .innerJoin(tariffs, eq(tariffPeriods.tariffId, tariffs.id))
        .where(eq(tariffPeriods.id, input.id))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Period not found" });
      assertOrgWrite(ctx.user, rows[0].orgId, "Tariff");
      await db.delete(tariffPeriods).where(eq(tariffPeriods.id, input.id));
      return { ok: true };
    }),

    // An imported hourly curve: what a market-exposed site needs. Upserted by
    // hour, so re-importing a day that was already loaded corrects it instead
    // of leaving two prices for the same hour.
    importPrices: operator
      .input(
        z.object({
          tariffId: z.number(),
          source: z.string().min(1).max(64).default("manual"),
          prices: z
            .array(
              z.object({
                hourStart: z.date(),
                importPrice: z.number().finite().min(0),
                exportPrice: z.number().finite().min(0).nullable().optional(),
              }),
            )
            .min(1)
            .max(2000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const db = getDb();
        const rows = await db.select({ orgId: tariffs.orgId }).from(tariffs).where(eq(tariffs.id, input.tariffId)).limit(1);
        if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Tariff not found" });
        assertOrgWrite(ctx.user, rows[0].orgId, "Tariff");
        // Floored to the hour: a curve with prices at 13:07 would never match
        // the hourly lookup and would silently do nothing. Two prices for the
        // same hour keep the later one, as importing them in turn would.
        const byHour = new Map<number, { importPrice: number; exportPrice: number | null }>();
        for (const p of input.prices) {
          byHour.set(Math.floor(p.hourStart.getTime() / 3_600_000) * 3_600_000, {
            importPrice: p.importPrice,
            exportPrice: p.exportPrice ?? null,
          });
        }
        const values = [...byHour].map(([hourMs, p]) => ({
          tariffId: input.tariffId,
          hourStart: new Date(hourMs),
          importPrice: p.importPrice,
          exportPrice: p.exportPrice,
          source: input.source,
        }));
        // Multi-row upserts rather than one round trip per hour: a year of
        // hourly prices was 2,000 sequential statements inside one request.
        for (let i = 0; i < values.length; i += 500) {
          await db
            .insert(tariffPrices)
            .values(values.slice(i, i + 500))
            .onDuplicateKeyUpdate({
              set: {
                importPrice: sql`values(import_price)`,
                exportPrice: sql`values(export_price)`,
                source: sql`values(source)`,
              },
            });
        }
        return { imported: values.length };
      }),
  }),

  // Per-battery economics, and the planner that uses them.
  economics: createRouter({
    list: authed.query(async ({ ctx }) => {
      const db = getDb();
      const rows = await db
        .select({ econ: batteryEconomics, meterName: meters.name })
        .from(batteryEconomics)
        .innerJoin(meters, eq(batteryEconomics.meterId, meters.id))
        .where(orgWhere(ctx.user, batteryEconomics.orgId))
        .orderBy(meters.name);
      return rows.map((r) => ({ ...r.econ, meterName: r.meterName }));
    }),

    set: operator
      .input(
        z.object({
          meterId: z.number(),
          maxPowerKw: z.number().finite().positive().max(100_000),
          roundTripEfficiency: z.number().finite().min(0.1).max(1),
          minSocPct: z.number().finite().min(0).max(100),
          maxSocPct: z.number().finite().min(0).max(100),
          cycleCost: z.number().finite().min(0),
          optimizerEnabled: z.boolean().default(false),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.maxSocPct <= input.minSocPct) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "maxSoc must be above minSoc" });
        }
        const org = await meterOrg(input.meterId);
        assertOrgWrite(ctx.user, org, "Device");
        const db = getDb();
        const { meterId, ...rest } = input;
        await db
          .insert(batteryEconomics)
          .values({ meterId, ...rest, orgId: org ?? null })
          .onDuplicateKeyUpdate({ set: rest });
        return { ok: true };
      }),

    // What the planner WOULD do, from the same function that does it. An
    // operator should be able to see the plan before letting it command a
    // battery, and a preview running different code from the real path would
    // be worth nothing.
    preview: authed.input(z.object({ meterId: z.number() })).query(async ({ ctx, input }) => {
      assertOrgRead(ctx.user, await meterOrg(input.meterId), "Device");
      return optimizeBattery(input.meterId, true);
    }),
  }),
});
