ALTER TABLE "pr_comments" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "excerpt" text;