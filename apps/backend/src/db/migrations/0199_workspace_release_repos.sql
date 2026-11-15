-- RELEASES: RELEASABLE REPOSITORIES, THE START TAG, THE FIXED HYPHEN (2026-11-15; docs/RELEASES.md
-- § Implementation → Releasable repos and start tag). CORE, additive.
--
--   workspace_release_repos   NEW: one row per (account, workspace, repo) ticked "Released from this
--                             workspace" (Settings → Releases). No row = not released from it (the
--                             default: none ticked). Holds the reader's "Start from this tag" (name +
--                             the commit it was at, who, when). Composite FKs to workspaces and repos,
--                             cascading.
--   workspaces.release_suffix / hotfix_suffix   the hyphen is now FIXED (the reader types `rc`, the
--                             stored suffix is `-rc`): a stored value that does not start with `-` gets
--                             one in front.
CREATE TABLE IF NOT EXISTS `workspace_release_repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`start_tag_name` text,
	`start_tag_sha` text,
	`start_set_by_login` text,
	`start_set_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_release_repos_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_release_repos_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_release_repos_account_ws_repo` ON `workspace_release_repos` (`account_id`,`workspace_id`,`repo_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_release_repos_account_repo_idx` ON `workspace_release_repos` (`account_id`,`repo_id`);
--> statement-breakpoint
UPDATE `workspaces` SET `release_suffix` = '-' || `release_suffix` WHERE `release_suffix` IS NOT NULL AND trim(`release_suffix`) <> '' AND substr(`release_suffix`, 1, 1) <> '-';
--> statement-breakpoint
UPDATE `workspaces` SET `hotfix_suffix` = '-' || `hotfix_suffix` WHERE `hotfix_suffix` IS NOT NULL AND trim(`hotfix_suffix`) <> '' AND substr(`hotfix_suffix`, 1, 1) <> '-';
