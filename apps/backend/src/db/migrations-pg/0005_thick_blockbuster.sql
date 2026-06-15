ALTER TABLE "repos" ADD COLUMN "inbox_watch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "inbox_watch_started_at" timestamp with time zone;