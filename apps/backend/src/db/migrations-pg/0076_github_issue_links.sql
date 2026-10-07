-- GITHUB ISSUES LINKS — the Postgres twin of migrations/0089_github_issue_links.sql (read that file
-- for the rationale). The issues a PR closes, as GitHub states them, read only for GitHub Issues
-- workspaces; NULL is "never read", never "closes nothing". Additive.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "closing_issues" jsonb;
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "closing_issues_checked_at" timestamp with time zone;
