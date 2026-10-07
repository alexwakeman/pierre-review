-- LINEAR LINKS — the Postgres twin of migrations/0090_linear_links.sql (read that file for the
-- rationale). The Linear issues a PR is attached to, read only for Linear workspaces with a saved
-- key, and the Linear workspace they were read against; NULL is "never read". Additive.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "linear_links" jsonb;
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "linear_links_root" text;
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "linear_links_checked_at" timestamp with time zone;
