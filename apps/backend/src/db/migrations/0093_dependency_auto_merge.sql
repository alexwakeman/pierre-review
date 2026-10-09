-- DEPENDENCY AUTO-MERGE (docs/MERGE-CI-TRUNK.md § Dependency auto-merge). The Postgres twin is
-- migrations-pg/0080_dependency_auto_merge.sql. Additive; no data to move.
--
--   workspaces.dependency_auto_merge       NULL/false = off (the default). On, the server arms
--                                          "merge when ready" on the workspace's open
--                                          dependency-automation PRs (merge/dependency-policy.ts).
--   auto_merge_requests.armed_by_policy    NULL/false = a person armed it.
--   auto_merge_policy_skips                one row per PR whose intent a person cancelled; the
--                                          policy never re-arms it. Composite FK against
--                                          pull_requests(id, account_id); both delete paths and
--                                          eraseAccountData delete it explicitly.
ALTER TABLE `workspaces` ADD `dependency_auto_merge` integer;
--> statement-breakpoint
ALTER TABLE `auto_merge_requests` ADD `armed_by_policy` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auto_merge_policy_skips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `amps_pr_account_fk` FOREIGN KEY (`pr_id`,`account_id`) REFERENCES `pull_requests`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `amps_account_pr` ON `auto_merge_policy_skips` (`account_id`,`pr_id`);
