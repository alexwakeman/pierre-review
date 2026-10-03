-- Postgres twin of migrations/0077_claude_review_ci_failures.sql, where the contract lives:
-- claude_reviews.ci_failures (the head's CI state at review time and Claude's diagnosis of each
-- failing check). Nullable, no backfill.
ALTER TABLE "claude_reviews" ADD COLUMN IF NOT EXISTS "ci_failures" jsonb;
