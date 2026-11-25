-- THE TEAM POLICY (2026-11-24; docs/TEAM-POLICY.md). ONE row per (account, repo): the parsed
-- `.ensemble/policy.json` from the repo's default branch, or the parser's problems. Additive; no backfill
-- (the next sync reads it). Tenancy via the named composite FK onto `repos (id, account_id)`.
CREATE TABLE IF NOT EXISTS `repo_team_policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`policy_json` text,
	`errors_json` text NOT NULL,
	`commit_oid` text,
	`read_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `repo_team_policies_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `repo_team_policies_account_repo` ON `repo_team_policies` (`account_id`,`repo_id`);
