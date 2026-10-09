-- REVIEW CHAT "EXPLAIN THESE" TURNS — the Postgres twin of migrations/0095_review_chat_explain.sql
-- (read that file for the rationale). Additive.
ALTER TABLE "claude_review_chat_messages" ADD COLUMN IF NOT EXISTS "pins" jsonb;
--> statement-breakpoint
ALTER TABLE "claude_review_chat_messages" ADD COLUMN IF NOT EXISTS "explanations" jsonb;
