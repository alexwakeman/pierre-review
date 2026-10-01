-- Postgres twin of migrations/0071_claude_review_trigger.sql, where the contract lives.
-- 'manual' | 'auto'; existing rows read 'manual'. Claude Review is local-only, so the column exists
-- in Postgres for schema parity.
ALTER TABLE "claude_reviews" ADD COLUMN IF NOT EXISTS "trigger" text DEFAULT 'manual' NOT NULL;
