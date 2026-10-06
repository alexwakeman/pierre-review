-- Postgres twin of migrations/0085_auto_review_daily_cap.sql: the per-workspace auto review daily
-- cap. NULL = the default 20.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_review_daily_cap" integer;
