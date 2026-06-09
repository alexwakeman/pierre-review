ALTER TABLE "pull_requests" ADD COLUMN "additions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "deletions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "changed_files" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "files" jsonb;