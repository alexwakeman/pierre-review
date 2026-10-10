-- REPORTS → THIS SPRINT: the twin of migrations/0102_workspace_sprint_checks.sql (read its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "sprint_checks" jsonb;
