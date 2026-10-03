-- Postgres twin of migrations/0076_claude_review_threads.sql, where the contract lives:
-- claude_reviews.thread_assessments (other reviewers' open threads, judged) and
-- claude_reviews.comments_through (the comment half of the auto re-review key). Both nullable, no
-- backfill.
ALTER TABLE "claude_reviews" ADD COLUMN IF NOT EXISTS "thread_assessments" jsonb;
--> statement-breakpoint
ALTER TABLE "claude_reviews" ADD COLUMN IF NOT EXISTS "comments_through" timestamp with time zone;
