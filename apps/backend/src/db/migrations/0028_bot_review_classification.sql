-- Bot-Triage Platform (WS1): account-scoped classification cache for automated
-- reviewers. One row per (account, author); AUTO rows written by the layered resolver,
-- MANUAL rows (source='manual') by the override route and never overwritten by auto.
-- Merged with the global vendor login map on read. Account-scoped isolation.
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
CREATE TABLE `bot_review_classification` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`author_user_id` integer NOT NULL,
	`automated` integer NOT NULL,
	`kind` text,
	`label` text,
	`confidence` text NOT NULL,
	`source` text NOT NULL,
	`reasons_json` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brc_account_author` ON `bot_review_classification` (`account_id`,`author_user_id`);
