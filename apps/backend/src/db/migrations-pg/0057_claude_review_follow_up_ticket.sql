-- Postgres twin of migrations/0070_claude_review_follow_up_ticket.sql. See the sqlite original for
-- the contracts and why prior_finding_id is a soft reference with no FK. Claude Review is
-- local-only, so these columns exist in Postgres for schema parity. jsonb against sqlite's text
-- json mode is the standard divergence (schema.pg.ts header).
ALTER TABLE "claude_reviews" ADD COLUMN IF NOT EXISTS "ticket" jsonb;
ALTER TABLE "claude_reviews" ADD COLUMN IF NOT EXISTS "ticket_assessment" jsonb;
ALTER TABLE "claude_reviews" ADD COLUMN IF NOT EXISTS "follow_up" jsonb;
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "prior_finding_id" integer;
