-- Postgres twin of migrations/0057_large_pr_threshold.sql — the LARGE-PR FLAG's per-account
-- code-churn threshold (CORE, free, no AI). HAND-WRITTEN ADDITIVE, like every pg migration since
-- 0023: never regenerate the baseline with `pnpm db:generate:pg`, which squashes it.
-- Nullable, no default, no backfill: NULL = use the 1,500-line product default (see the sqlite
-- twin for why that is deliberately not a backfilled literal).
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "large_pr_code_loc_threshold" integer;
