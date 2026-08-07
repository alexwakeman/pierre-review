-- Per-seat bot pricing + repo descriptions — the Postgres twin of sqlite
-- 0049_seat_pricing_repo_description.sql. HAND-WRITTEN ADDITIVE, like every pg migration
-- since 0023: never regenerate the baseline with `pnpm db:generate:pg`, which squashes it.
--
-- See the sqlite twin for the full argument. In short: `cost_model` says how `monthly_cents`
-- is read ('flat' = whole-workspace subscription, the default so every existing row keeps its
-- meaning; 'per_seat' = unit price × the workspace's derived human seat count, product never
-- stored), with ownership identical to `monthly_cents` (one writer, `setReviewerCost`).
-- `repos.description` is the GitHub "About" text captured by the activity sync — grounding
-- for the workspace-purpose sprint-chat preset.
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "workspace_reviewers" ADD COLUMN IF NOT EXISTS "cost_model" text DEFAULT 'flat' NOT NULL;
