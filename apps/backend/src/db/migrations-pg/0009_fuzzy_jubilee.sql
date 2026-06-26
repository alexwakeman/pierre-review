ALTER TABLE "claude_reviews" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "claude_reviews" ADD COLUMN "cache_creation_tokens" integer;--> statement-breakpoint
ALTER TABLE "claude_reviews" ADD COLUMN "diff_bytes" integer;--> statement-breakpoint
ALTER TABLE "claude_reviews" ADD COLUMN "diff_capped" boolean;