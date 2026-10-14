-- ACTIVITY → THIS SPRINT: the sprint's DATES + the story pass's last ATTEMPT (2026-10-14). Twin of
-- migrations/0111_sprint_dates_story_attempt.sql, where the contract lives.
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "sprint_reads" ADD COLUMN IF NOT EXISTS "sprint_starts_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sprint_reads" ADD COLUMN IF NOT EXISTS "sprint_ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sprint_reads" ADD COLUMN IF NOT EXISTS "story_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sprint_reads" ADD COLUMN IF NOT EXISTS "story_attempt_hash" text;
--> statement-breakpoint
ALTER TABLE "sprint_reads" ADD COLUMN IF NOT EXISTS "story_attempt_error" text;
