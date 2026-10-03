-- Postgres twin of migrations/0079_claude_finding_story.sql, where the contract lives:
-- claude_review_findings.story_index (the ticket's 0-based position on the run) and
-- claude_review_findings.story_ref ('AC2' / 'M1') mark a finding the server made from the run's
-- user-story assessment. Both NULL on an ordinary finding. Nullable, no backfill.
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "story_index" integer;
--> statement-breakpoint
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "story_ref" text;
