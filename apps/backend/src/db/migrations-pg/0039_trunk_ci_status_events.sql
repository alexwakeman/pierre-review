-- Default-branch ("trunk") CI transition log — the Postgres twin of sqlite
-- 0052_trunk_ci_status_events.sql. HAND-WRITTEN ADDITIVE, like every pg migration since 0023:
-- never regenerate the baseline with `pnpm db:generate:pg`, which squashes it.
--
-- See the sqlite twin for the full argument. In short: `branch_commits.ci_status` is updated IN
-- PLACE, so the moment trunk turned red is otherwise unrecorded; rows are written only on a
-- TRANSITION and only on a POSITIVE statement from GitHub (an `unknown` rollup — which is also
-- what a `graphqlTolerant` partial produces — records nothing); `observed_at` is OUR observation
-- time; `failing_checks` is the BranchCheckRun[] render payload, not ci_status_events' bare
-- string[]; and the table is bounded by its own per-repo trim, because the retention sweep
-- anchors to a parent PR's `updated_at` and a trunk row has no PR. That trim is HYBRID (newest
-- TRUNK_CI_EVENT_WINDOW rows UNION everything inside FEED_WINDOW_DAYS) — a pure count bound
-- evicted the very failure rows the Feed reads on the most active repos.
CREATE TABLE IF NOT EXISTS "trunk_ci_status_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "repo_id" integer NOT NULL REFERENCES "repos"("id") ON DELETE cascade,
  "branch_name" text,
  "head_sha" text NOT NULL,
  "status" text NOT NULL,
  "failing_checks" jsonb,
  "observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tcse_account_repo_observed" ON "trunk_ci_status_events" ("account_id","repo_id","observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tcse_account_idx" ON "trunk_ci_status_events" ("account_id");
