ALTER TABLE "review_threads" ADD COLUMN "addressed_confidence" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_threads" ADD COLUMN "addressed_reason" text;--> statement-breakpoint
ALTER TABLE "review_threads" ADD COLUMN "resolved_by_login" text;
