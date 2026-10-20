-- SPRINT BRIEF ONE-LINER — the Postgres twin of migrations/0123_sprint_brief_one_liner.sql (read its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "sprint_briefs" ADD COLUMN IF NOT EXISTS "one_liner" text;
