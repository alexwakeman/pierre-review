-- Default-branch commit detail — the Postgres twin of sqlite 0041_branch_commit_detail. See that
-- file for the full rationale: `failing_checks` stores FAILURES ONLY (null on a green commit) and
-- is never lean-gated because a trunk commit has no hydrate-on-demand path; `pr_number` is a plain
-- number rather than a `pull_requests` FK because the PR is frequently unsynced and an id would go
-- stale, so the read layer resolves it within (account_id, repo_id) instead. The `pull_requests`
-- index is what keeps that resolution a seek rather than a per-repo scan on a hot route.
ALTER TABLE "branch_commits" ADD COLUMN IF NOT EXISTS "failing_checks" jsonb;--> statement-breakpoint
ALTER TABLE "branch_commits" ADD COLUMN IF NOT EXISTS "pr_number" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_account_repo_number_idx" ON "pull_requests" ("account_id","repo_id","number");
