-- REPORTS → THIS SPRINT — the Postgres twin of migrations/0105_sprint_assessment_mode.sql (read its
-- header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "sprint_assessments" ADD COLUMN IF NOT EXISTS "mode" text;
