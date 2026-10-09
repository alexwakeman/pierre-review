-- GITHUB ISSUES AS THE AUTOMATIC DEFAULT TRACKER — the Postgres twin of
-- migrations/0094_repo_uses_github_issues.sql (read that file for the rationale — ⚠ only an ALL-NULL row becomes 'none'). Additive.
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "uses_github_issues" boolean;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "github_issues_checked_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "workspace_trackers" SET "provider" = 'none' WHERE "provider" IS NULL AND "base_url" IS NULL AND "project_keys" IS NULL AND "match_scope" IS NULL AND "auth_email" IS NULL AND "auth_token" IS NULL;
