-- WHEN REPOSITORIES' TEAM POLICIES DIFFER (2026-11-24; docs/TEAM-POLICY.md § Different rules). ONE row per
-- (account, workspace): the repo whose policy the workspace applies to work spanning repositories when their
-- policies clash. No row = the strictest rule from each. Additive; no backfill. Tenancy via named composite FKs.
CREATE TABLE IF NOT EXISTS `workspace_policy_choices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`clash_repo_id` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_policy_choices_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_policy_choices_repo_account_fk` FOREIGN KEY (`clash_repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_policy_choices_account_ws` ON `workspace_policy_choices` (`account_id`,`workspace_id`);
