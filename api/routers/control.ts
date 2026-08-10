// v7/C12: control tRPC — execute setpoints (operator/admin), inspect the
// writable whitelist and the command history (any authenticated user).
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { commands, meters } from "@db/schema";
import { ControlError, controllableForModel, executeAndLog } from "../control/execute";

export const controlRouter = createRouter({
  // Whitelist for one device (drives the UI control panel).
  controllableFor: authed
    .input(z.object({ meterId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(meters).where(eq(meters.id, input.meterId)).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      return controllableForModel(rows[0].model);
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
      try {
        return await executeAndLog(meter, input.key, input.value, ctx.user?.id ?? null);
      } catch (err) {
        if (err instanceof ControlError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  history: authed
    .input(z.object({ meterId: z.number(), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input }) => {
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
