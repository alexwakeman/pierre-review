-- THIS SPRINT → "NEEDS CODE" (docs/CLAUDE-REVIEW.md § Sprint code judgements). One cheap judgement per
-- (account, workspace, ticket ident): will this not-started ticket most likely need code changes, with
-- one short reason. Current while its text hash and judge version match. Tenancy via the named composite
-- FK onto `workspaces (id, account_id)`. Additive only.
CREATE TABLE IF NOT EXISTS `sprint_code_judgements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ident` text NOT NULL,
	`text_hash` text NOT NULL,
	`judge_version` integer NOT NULL,
	`needs_code` integer NOT NULL,
	`reason` text,
	`model` text NOT NULL,
	`provider` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `sprint_code_judgements_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sprint_code_judgements_account_ws_ident` ON `sprint_code_judgements` (`account_id`,`workspace_id`,`ident`);
