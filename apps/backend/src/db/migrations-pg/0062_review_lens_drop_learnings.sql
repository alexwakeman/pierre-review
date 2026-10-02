-- Postgres twin of migrations/0075_review_lens_drop_learnings.sql, where the contract lives:
-- claude_review_findings.lens (nullable, no backfill) and review memory's table dropped.
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "lens" text;
--> statement-breakpoint
DROP TABLE IF EXISTS "review_learnings";
