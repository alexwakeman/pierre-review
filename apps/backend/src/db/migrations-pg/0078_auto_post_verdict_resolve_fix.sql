-- AUTO-POST CI CAUSES · AUTO VERDICT · AUTO RESOLVE · AUTO FIX SETTINGS — the Postgres twin of
-- migrations/0091_auto_post_verdict_resolve_fix.sql (read that file for the rationale). Additive.
ALTER TABLE "ci_review_items" ADD COLUMN IF NOT EXISTS "confidence" integer;
--> statement-breakpoint
ALTER TABLE "ci_reviews" ADD COLUMN IF NOT EXISTS "auto_post" jsonb;
--> statement-breakpoint
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "auto_resolved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "auto_resolve" jsonb;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_fix_settings" jsonb;
