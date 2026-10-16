-- SONARCLOUD (2026-10-16; docs/SONARCLOUD.md). CORE, free, both modes.
--
--   workspace_sonar   NEW. ONE row per workspace: the SonarCloud organization, the SEALED write-only
--                     token (tracker/secret.ts forms) and per-repo project-key overrides (JSON map
--                     repoId → key). The workspace id arrives in a request PATH, so its FK is the
--                     named COMPOSITE one onto workspaces (id, account_id).
--   sonar_snapshots   NEW. ONE row per (account, PR, head): the ranked, capped issues, the quality
--                     gate and the totals SonarCloud reported, plus `post` — the ONE PR comment's
--                     record, claimed before the GitHub write and never retried. No FK on pr_id
--                     (the tracker_tickets precedent): both delete paths and the erasure take it.
-- The Postgres twin is migrations-pg/0101_sonarcloud.sql.
CREATE TABLE IF NOT EXISTS `workspace_sonar` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`organization` text,
	`auth_token` text,
	`project_keys` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_sonar_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_sonar_account_workspace` ON `workspace_sonar` (`account_id`,`workspace_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sonar_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`state` text NOT NULL,
	`message` text,
	`project_key` text,
	`quality_gate` text,
	`issues` text,
	`total_issues` integer DEFAULT 0 NOT NULL,
	`total_hotspots` integer DEFAULT 0 NOT NULL,
	`fetched_at` integer NOT NULL,
	`post` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sonar_snapshots_account_pr_head` ON `sonar_snapshots` (`account_id`,`pr_id`,`head_sha`);
