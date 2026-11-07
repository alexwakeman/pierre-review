-- SANDBOX WORKSPACE SETTINGS (docs/SANDBOX.md § The workspace mirror). CORE, additive.
--
--   sandbox_workspace_settings  NEW: one row per (account, workspace) — Settings → Workspace → Sandbox:
--                               the local folder, the ticked Claude memory projects, the user-level
--                               CLAUDE.md / skills switches, the starting folder, the global proxy
--                               switch and the resources. No row = every default; nothing inherited.
CREATE TABLE IF NOT EXISTS `sandbox_workspace_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`local_folder` text,
	`memory_projects_json` text,
	`user_claude_md` integer DEFAULT true NOT NULL,
	`user_skills` integer DEFAULT false NOT NULL,
	`start_dir` text,
	`global_proxy_env` integer DEFAULT false NOT NULL,
	`cpus` integer,
	`memory_gb` integer,
	`disk_gb` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sandbox_workspace_settings_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sandbox_workspace_settings_account_ws` ON `sandbox_workspace_settings` (`account_id`,`workspace_id`);
