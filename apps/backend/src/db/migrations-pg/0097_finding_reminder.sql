-- CLAUDE REVIEW → REMINDERS (2026-10-14). Twin of migrations/0110_finding_reminder.sql, where the
-- contract lives: the latest "Post reminder" of an already-posted finding. NULL = none.
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "reminder" jsonb;
