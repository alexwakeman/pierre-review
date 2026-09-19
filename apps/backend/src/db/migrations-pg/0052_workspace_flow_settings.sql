-- Postgres twin of migrations/0065_workspace_flow_settings.sql — a workspace's working hours,
-- time zone and wait budgets for Chronology, stored as OVERRIDES ONLY (NULL = every default).
-- See the sqlite original for why it is per workspace and why there is no backfill.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "flow_settings" jsonb;
