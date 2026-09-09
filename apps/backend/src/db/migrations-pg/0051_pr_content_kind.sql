-- Postgres twin of migrations/0064_pr_content_kind.sql — what a pull request's code churn
-- consists of ('comments' | 'formatting' | 'code'), plus the head sha it was read at. See the
-- sqlite original for why NULL is the common case, why there is no backfill, and why the sha
-- column is load-bearing rather than bookkeeping.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "content_kind" text;
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "content_kind_sha" text;
