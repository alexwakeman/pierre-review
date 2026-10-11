-- REPORTS → STORIES / THIS SPRINT — the Postgres twin of
-- migrations/0103_sprint_statuses_and_blockers.sql (read its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "tracker_tickets" ADD COLUMN IF NOT EXISTS "blocked_by_json" jsonb;
--> statement-breakpoint
ALTER TABLE "tracker_tickets" ADD COLUMN IF NOT EXISTS "status_id" text;
--> statement-breakpoint
ALTER TABLE "sprint_tickets" ADD COLUMN IF NOT EXISTS "blocked_by_json" jsonb;
--> statement-breakpoint
ALTER TABLE "sprint_tickets" ADD COLUMN IF NOT EXISTS "status_id" text;
--> statement-breakpoint
ALTER TABLE "sprint_reads" ADD COLUMN IF NOT EXISTS "status_order_json" jsonb;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "sprint_statuses" jsonb;
