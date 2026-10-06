-- Postgres twin of migrations/0087_auto_post.sql: auto-posting of Claude review output. A
-- per-workspace switch (NULL/false = off) + overrides-only settings, the per-run records and the
-- per-item "posted automatically" flags. The contract lives in schema.sqlite.ts.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_post_enabled" boolean;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_post_settings" jsonb;
--> statement-breakpoint
ALTER TABLE "claude_reviews" ADD COLUMN IF NOT EXISTS "auto_post" jsonb;
--> statement-breakpoint
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "posted_auto" boolean;
--> statement-breakpoint
ALTER TABLE "ticket_reviews" ADD COLUMN IF NOT EXISTS "auto_post" jsonb;
--> statement-breakpoint
ALTER TABLE "ticket_review_items" ADD COLUMN IF NOT EXISTS "posted_auto" boolean;
