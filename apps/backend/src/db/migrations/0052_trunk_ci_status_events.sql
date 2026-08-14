-- Default-branch ("trunk") CI TRANSITION log. SQLite / local mode; Postgres twin:
-- migrations-pg/0039_trunk_ci_status_events.sql. One additive table, no backfill.
--
-- WHY IT HAS TO EXIST. `branch_commits.ci_status` is updated IN PLACE by the branch snapshot's
-- idempotent upsert, so a trunk commit that turns red hours after it landed carries no record of
-- WHEN it turned red: the only timestamps on that row are `committed_at` (git commit time) and
-- `created_at` (first insertion). Presenting either as "trunk CI failed at" would be a quiet
-- lie, so the observation gets its own append-only row. This is the trunk twin of
-- `ci_status_events`, which does exactly the same job for a PR head.
--
-- WRITE RULES (sync/branch-status.ts): a row is written only on a TRANSITION (status / head sha
-- / failing-check name set differs from this repo's last row) AND only on a POSITIVE statement
-- from GitHub — an `unknown` rollup, which is also what `graphqlTolerant` produces when a
-- partial response NULLs the selection, records nothing at all. `observed_at` is OUR observation
-- time (the branch query selects no `completedAt`), so UI wording says "detected".
--
-- `failing_checks` carries the FULL BranchCheckRun[] render payload, matching
-- `branch_commits.failing_checks` — deliberately NOT `ci_status_events.failing_checks`, which is
-- a bare string[] of names for the CI metrics log. Same column name, different shape, on purpose.
--
-- Retention: bounded by its own per-repo trim in the writer, because the time-based sweep anchors
-- everything to a parent PR's `updated_at` and a trunk row has no PR. That trim is HYBRID — the
-- newest TRUNK_CI_EVENT_WINDOW rows UNION everything still inside FEED_WINDOW_DAYS
-- (`staleTrunkCiEventIds`) — exactly like `branch_commits`, and for opposite reasons in each
-- direction: a pure COUNT bound evicted the failure rows the Feed reads on repos that sync faster
-- than the read window elapses, and a pure AGE bound would delete a dormant repo's entire log.
-- FKs CASCADE so a repo delete / account erasure cleans up regardless; both are ALSO done
-- explicitly (deleteRepo / eraseAccountData) so the guarantee doesn't depend on `foreign_keys=ON`.
CREATE TABLE IF NOT EXISTS `trunk_ci_status_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `repo_id` integer NOT NULL REFERENCES `repos`(`id`) ON DELETE cascade,
  `branch_name` text,
  `head_sha` text NOT NULL,
  `status` text NOT NULL,
  `failing_checks` text,
  `observed_at` integer NOT NULL
);
--> statement-breakpoint
-- The read (the Feed builder) and the per-repo trim: one repo's log, newest first.
CREATE INDEX IF NOT EXISTS `tcse_account_repo_observed` ON `trunk_ci_status_events` (`account_id`,`repo_id`,`observed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tcse_account_idx` ON `trunk_ci_status_events` (`account_id`);
