// v7/C11: API-key management (admin only). The raw key is returned EXACTLY
// once at creation; afterwards only the prefix identifies it.
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createRouter, admin } from "../middleware";
import { getDb } from "../queries/connection";
import { apiKeys } from "@db/schema";
import { evictApiKeyCache, generateApiKey } from "../lib/api-keys";

export const apiKeysRouter = createRouter({
  list: admin.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        role: apiKeys.role,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt));
    return rows;
  }),

  create: admin
    .input(z.object({ name: z.string().min(1).max(255), role: z.enum(["admin", "operator", "viewer"]).default("viewer") }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { raw, hash, prefix } = generateApiKey();
      const inserted = await db
        .insert(apiKeys)
        .values({ name: input.name, keyHash: hash, prefix, role: input.role, createdBy: ctx.user?.id ?? null })
        .$returningId();
      // The ONLY time the raw key is ever returned or stored anywhere.
      return { id: inserted[0].id, key: raw, prefix, name: input.name, role: input.role };
    }),

  revoke: admin.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, input.id));
    evictApiKeyCache();
    return { ok: true };
  }),
});
