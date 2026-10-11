-- REPORTS → THIS SPRINT — the Postgres twin of migrations/0104_sprint_ticket_repos_saved.sql (read
-- its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "sprint_tickets" ADD COLUMN IF NOT EXISTS "repos_saved_at" timestamp with time zone;
