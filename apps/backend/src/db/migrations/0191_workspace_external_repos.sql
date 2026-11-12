-- A REPO IN MORE THAN ONE WORKSPACE (2026-11-12; docs/DATA-MODEL.md § External repos). CORE, additive.
--
--   workspace_external_repos  NEW: one row per (account, workspace, repo) — an EXTRA External
--                             membership. A repo keeps its ONE home row in `workspace_repos`
--                             (Maintained or External there) and is External in any number of
--                             other workspaces through this table. Never the home workspace.
--                             Read only through db/external-repos.ts.
CREATE TABLE IF NOT EXISTS `workspace_external_repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_external_repos_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_external_repos_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_external_repos_account_ws_repo` ON `workspace_external_repos` (`account_id`,`workspace_id`,`repo_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_external_repos_account_repo_idx` ON `workspace_external_repos` (`account_id`,`repo_id`);
