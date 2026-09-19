-- Postgres twin of migrations/0068_my_turn_settings.sql. See the sqlite original for why the
-- settings are overrides-only with no backfill, and why mentioned_at starts NULL. jsonb against
-- sqlite's text json mode is the standard divergence (schema.pg.ts header).
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "my_turn_settings" jsonb;
ALTER TABLE "pr_mentions" ADD COLUMN IF NOT EXISTS "mentioned_at" timestamp with time zone;
ALTER TABLE "pr_mentions" ADD COLUMN IF NOT EXISTS "mentioned_by_user_id" integer;
