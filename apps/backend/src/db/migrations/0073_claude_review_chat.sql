-- CLAUDE REVIEW CHAT (local-only feature): one row per chat message about one succeeded review —
-- a general thread (`finding_id` NULL) and one thread per finding. The transcript the model sees
-- is rebuilt SERVER-SIDE from these rows each turn. Never carried across reviews.
--
-- `review_id` arrives in a request path, so tenancy is STRUCTURAL: a composite FK against
-- claude_reviews(id, account_id), whose parent key `claude_reviews_id_account` is new here (`id` is
-- the primary key, so it is never a lookup). Both delete paths (deleteRepo, retention's
-- deletePrSubtree) and eraseAccountData delete these rows explicitly, before their parents.
-- The Postgres twin is migrations-pg/0060_claude_review_chat.sql.
CREATE UNIQUE INDEX IF NOT EXISTS `claude_reviews_id_account` ON `claude_reviews` (`id`,`account_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `claude_review_chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`review_id` integer NOT NULL,
	`finding_id` integer,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`model` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `claude_review_findings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `crcm_review_account_fk` FOREIGN KEY (`review_id`,`account_id`) REFERENCES `claude_reviews`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `crcm_thread_idx` ON `claude_review_chat_messages` (`review_id`,`finding_id`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `crcm_account_idx` ON `claude_review_chat_messages` (`account_id`);
