-- FIGMA (2026-11-21; docs/IMPLEMENT-UI-PLAN.md § 3, docs/SANDBOX.md § The ticket relay). CORE.
--
--   workspace_figma   NEW. ONE row per workspace: the SEALED write-only Figma personal access token
--                     (tracker/secret.ts forms). Read ONLY on the host, by `ensemble-ticket figma` in a
--                     workspace session the reader started. The workspace id arrives in a request PATH, so
--                     its FK is the named COMPOSITE one onto workspaces (id, account_id).
CREATE TABLE IF NOT EXISTS `workspace_figma` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`auth_token` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_figma_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_figma_account_workspace` ON `workspace_figma` (`account_id`,`workspace_id`);
