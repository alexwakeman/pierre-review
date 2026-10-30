-- DEPENDENCY AUTOMATION (docs/MERGE-CI-TRUNK.md § Dependency automation). Additive; no data to move.
--
--   workspaces.dependency_auto_approve / _auto_resolve   NULL/false = off (the default).
--   workspaces.dependency_max_level                      NULL = 'major' (every size).
--   workspaces.dependency_security_only                  NULL/false = every update.
--   workspaces.dependency_ecosystems                     JSON array; NULL = every ecosystem.
--   workspace_reviewers.dependency_trusted               the reader's trust mark; NULL = not trusted.
--   dependency_automation_actions                        one claimed row per (PR, head, action).
--                                                        Composite FK against pull_requests(id,
--                                                        account_id); both delete paths and
--                                                        eraseAccountData delete it explicitly.
ALTER TABLE `workspaces` ADD `dependency_auto_approve` integer;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `dependency_auto_resolve` integer;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `dependency_max_level` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `dependency_security_only` integer;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `dependency_ecosystems` text;
--> statement-breakpoint
ALTER TABLE `workspace_reviewers` ADD `dependency_trusted` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dependency_automation_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`action` text NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`result_sha` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `daa_pr_account_fk` FOREIGN KEY (`pr_id`,`account_id`) REFERENCES `pull_requests`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `daa_account_pr_head_action` ON `dependency_automation_actions` (`account_id`,`pr_id`,`head_sha`,`action`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `daa_account_created_idx` ON `dependency_automation_actions` (`account_id`,`created_at`);
