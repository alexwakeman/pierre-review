-- TRACKER TICKET DATES — the Postgres twin of migrations/0098_tracker_ticket_dates.sql (read its
-- header). ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "tracker_tickets" ADD COLUMN IF NOT EXISTS "issue_created_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tracker_tickets" ADD COLUMN IF NOT EXISTS "issue_resolved_at" timestamp with time zone;
