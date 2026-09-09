-- Postgres twin of migrations/0062_blast_radius_config.sql — the blast-radius reading settings
-- (CORE, free, no AI), one nullable JSON blob per account. See the sqlite original for why this
-- is account-grained, why it is one JSON column rather than six integers, and why it is nullable
-- with no backfill.
--
-- `jsonb` here against sqlite's `text` json mode: the standard divergence in this schema pair
-- (the header of schema.pg.ts records the mapping), and both read back as the same object.
ALTER TABLE "accounts" ADD COLUMN "blast_radius_config" jsonb;
