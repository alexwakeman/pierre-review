-- REPORTS → THIS SPRINT: the twin of migrations/0101_sprint_reads_api_root.sql (read its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "sprint_reads" ADD COLUMN IF NOT EXISTS "api_root" text;
