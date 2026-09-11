-- v9 / BESS control fail-closed safety: per-plan state-of-charge limits.
--
-- This migration was referenced by the commit that added ems_plans.min_soc /
-- max_soc to db/schema.ts but was never committed, because db/migrations/*.sql
-- was gitignored at the time. The columns therefore existed in the ORM model
-- and in freshly generated demo snapshots, but no upgrade path existed for an
-- already-deployed database. Re-created here from the schema definition.
--
-- min_soc / max_soc bound an active plan's discharge and charge respectively;
-- NULL means "no plan-level limit" and the device profile's own limits apply.
-- Non-destructive ADD COLUMN — safe online.
ALTER TABLE ems_plans
  ADD COLUMN min_soc double NULL,
  ADD COLUMN max_soc double NULL;
