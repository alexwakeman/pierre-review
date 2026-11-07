-- SANDBOX "ALWAYS ALLOW" HOSTS (docs/SANDBOX.md § The allow-list). CORE, additive.
--
--   sandbox_allowed_hosts  NEW: one row per host rule a reader allowed for every sandbox session of one
--                          workspace. The rule is stored NORMALISED by the proxy's parser, so the unique
--                          index never holds two spellings of one host. No rows by default: the built-in
--                          defaults live in code (sandbox/proxy/allow-list.ts), never here.
CREATE TABLE IF NOT EXISTS `sandbox_allowed_hosts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`rule` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sandbox_allowed_hosts_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sandbox_allowed_hosts_rule` ON `sandbox_allowed_hosts` (`account_id`,`workspace_id`,`rule`);
