-- "@you" on a PR — the MENTION arm of My Turn's personal-relevance rule (CORE, no AI).
-- One row per (account, PR) where the account's viewer login is @mentioned in a PR comment, a
-- review body or an inline review comment. PRESENCE IS THE FACT: there is no `mentioned` flag
-- and no "scanned, found nothing" row, so every reader is a single indexed existence check.
-- Written ONLY by the background scanner (sync/mention-scan.ts), which re-derives the full set
-- per account per tick and diffs it against what is stored. Contract: docs/DATA-MODEL.md.
-- The Postgres twin is migrations-pg/0043_pr_mentions.sql.
CREATE TABLE IF NOT EXISTS `pr_mentions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`login` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `prm_account_pr` ON `pr_mentions` (`account_id`,`pr_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prm_account_repo_idx` ON `pr_mentions` (`account_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prm_pr_idx` ON `pr_mentions` (`pr_id`);
