// v7/C12: control tRPC — execute setpoints (operator/admin), inspect the
// writable whitelist and the command history (any authenticated user).
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { commands, meters } from "@db/schema";
import { ControlError, controllableForModel, executeAndLog, executeControl, verificationForModel } from "../control/execute";
import { assertOrgRead, assertOrgWrite, meterOrg } from "../lib/org-scope";

export const controlRouter = createRouter({
  // Whitelist for one device (drives the UI control panel).
  controllableFor: authed
    .input(z.object({ meterId: z.number() }))
    .query(async ({ input, ctx }) => {
      assertOrgRead(ctx.user, await meterOrg(input.meterId), "Device"); // v8/D2
      const db = getDb();
      const rows = await db.select().from(meters).where(eq(meters.id, input.meterId)).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      return controllableForModel(rows[0].model);
    }),

  // Wave 5 / T1: verification state of the meter's device profile (drives the
  // "control unavailable — profile unverified" UI). null = no profile at all.
  profileStatus: authed
    .input(z.object({ meterId: z.number() }))
    .query(async ({ input, ctx }) => {
      assertOrgRead(ctx.user, await meterOrg(input.meterId), "Device"); // v8/D2
      const db = getDb();
      const rows = await db.select().from(meters).where(eq(meters.id, input.meterId)).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      // §9.4: the lock rides along with the verification state because both
      // answer the same question the screen is asking — may this device be
      // commanded right now — and one query is cheaper than two.
      const verification = await verificationForModel(rows[0].model);
      return {
        ...(verification ?? {}),
        verificationStatus: verification?.verificationStatus ?? null,
        allowUnverifiedControl: verification?.allowUnverifiedControl ?? false,
        lockedAt: rows[0].controlLockedAt,
        lockReason: rows[0].controlLockReason,
      };
    }),

  execute: operator
    .input(
      z.object({
        meterId: z.number(),
        key: z.string().min(1).max(64),
        value: z.number().finite(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const rows = await db.select().from(meters).where(eq(meters.id, input.meterId)).limit(1);
      const meter = rows[0];
      if (!meter) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      assertOrgWrite(ctx.user, meter.orgId, "Device"); // v8/D2
      try {
        return await executeAndLog(meter, input.key, input.value, ctx.user?.id ?? null);
      } catch (err) {
        if (err instanceof ControlError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  // §9.4: rehearse a setpoint. Same code path as the real write, stopping
  // before the bus — so what this reports is what would happen, not a second
  // implementation's opinion of it. Operator-gated like the real thing:
  // knowing a device's writable range and verification state is not something
  // to hand to a viewer.
  preview: operator
    .input(
      z.object({
        meterId: z.number(),
        key: z.string().min(1).max(64),
        value: z.number().finite(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const rows = await db.select().from(meters).where(eq(meters.id, input.meterId)).limit(1);
      const meter = rows[0];
      if (!meter) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      assertOrgWrite(ctx.user, meter.orgId, "Device");
      try {
        return await executeControl(meter, input.key, input.value, { dryRun: true });
      } catch (err) {
        // A rejection IS the useful answer here — report it as a result rather
        // than an error, so the caller sees why without a failed request.
        if (err instanceof ControlError) {
          return { status: "failed" as const, detail: err.message };
        }
        throw err;
      }
    }),

  // §9.4 emergency stop. Refusing every write to one device is a safety action,
  // not a configuration change: with four automatic writers plus the watchdog
  // now commanding plant, "stop touching this device" had no expression at all.
  // The lock is read straight from the database inside executeControl, so it
  // binds the next tick rather than the next cache expiry.
  setLock: operator
    .input(
      z.object({
        meterId: z.number(),
        locked: z.boolean(),
        reason: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const rows = await db.select().from(meters).where(eq(meters.id, input.meterId)).limit(1);
      const meter = rows[0];
      if (!meter) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      assertOrgWrite(ctx.user, meter.orgId, "Device");

      if (input.locked) {
        // Drive to a safe state BEFORE locking, not after: the lock refuses
        // every write including this one, so the order is what decides whether
        // an emergency stop actually stops anything. Best effort — a device
        // that cannot be reached is exactly the case where the lock matters
        // most, so failing to reach it must not prevent the lock.
        let safeState = "no writable setpoint to zero";
        try {
          const allowed = await controllableForModel(meter.model);
          const key = Object.keys(allowed).find((k) => allowed[k].min <= 0 && allowed[k].max >= 0);
          if (key) {
            const res = await executeAndLog(meter, key, 0, ctx.user?.id ?? null);
            safeState = `${key} → 0 (${res.status})`;
          }
        } catch (err) {
          safeState = `safe-state write failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        await db
          .update(meters)
          .set({
            controlLockedAt: new Date(),
            controlLockedBy: ctx.user?.id ?? null,
            controlLockReason: input.reason?.trim() || null,
          })
          .where(eq(meters.id, input.meterId));
        return { ok: true, locked: true, safeState };
      }

      await db
        .update(meters)
        .set({ controlLockedAt: null, controlLockedBy: null, controlLockReason: null })
        .where(eq(meters.id, input.meterId));
      return { ok: true, locked: false, safeState: null };
    }),

  history: authed
    .input(z.object({ meterId: z.number(), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      assertOrgRead(ctx.user, await meterOrg(input.meterId), "Device"); // v8/D2
      const db = getDb();
      return db
        .select({
          id: commands.id,
          kind: commands.kind,
          status: commands.status,
          controlKey: commands.controlKey,
          controlValue: commands.controlValue,
          result: commands.result,
          userId: commands.userId,
          createdAt: commands.createdAt,
        })
        .from(commands)
        .where(eq(commands.meterId, input.meterId))
        .orderBy(desc(commands.createdAt))
        .limit(input.limit);
    }),
});
