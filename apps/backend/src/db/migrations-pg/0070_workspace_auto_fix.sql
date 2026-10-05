-- Postgres twin of migrations/0083_workspace_auto_fix.sql — the per-workspace auto AI Fix switch.
-- DEFAULT true so every existing workspace keeps today's behaviour. See the sqlite original.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_fix_enabled" boolean DEFAULT true NOT NULL;
