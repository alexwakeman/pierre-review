-- LIMN'S ACTIONS ARE BOTS (2026-11-08; docs/CLAUDE-REVIEW.md § Limn's actions are bots). CORE, additive.
-- Owner rule: "Everything Limn does on my behalf is not me."
--
--   limn_actions   NEW. The provenance ledger: ONE row per GitHub write Limn made (or tried) under a
--                  person's account. Written by the write functions themselves, claimed before the call.
--   reviews.limn_posted_by_user_id            the person behind a review Limn posted (author_id = bot).
--   review_comments.review_database_id        GitHub's id of the review a comment belongs to (the
--                                             wrapper rule: an empty review whose comments are all Limn's).
--   commits.limn_pushed_by_user_id            the person behind a commit Limn made (author_id = bot).
--   pull_requests.limn_merged_for_user_id     the person a Limn merge landed for (merged_by_id = bot).
--   pull_requests.limn_opened_for_user_id     the person a Limn-opened PR is for (author_id = bot).
-- No backfill here: the re-attribution is code (db/limn-bots.ts `reattributeLimnRows`).
-- Tenancy: composite FKs onto repos and pull_requests (id, account_id), cascade; explicit in both
-- delete paths and `accountScopedTables()` anyway.
CREATE TABLE IF NOT EXISTS `limn_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`pr_id` integer,
	`pr_number` integer,
	`kind` text NOT NULL,
	`claim_key` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`github_node_id` text,
	`github_database_id` text,
	`commit_sha` text,
	`review_database_id` text,
	`on_behalf_user_id` integer,
	`source_table` text,
	`source_id` integer,
	`detail` text,
	`at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`on_behalf_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `limn_actions_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `limn_actions_pr_account_fk` FOREIGN KEY (`pr_id`,`account_id`) REFERENCES `pull_requests`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `limn_actions_claim` ON `limn_actions` (`account_id`,`kind`,`claim_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `limn_actions_pr_idx` ON `limn_actions` (`account_id`,`pr_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `limn_actions_dbid_idx` ON `limn_actions` (`account_id`,`github_database_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `limn_actions_review_dbid_idx` ON `limn_actions` (`account_id`,`review_database_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `limn_actions_sha_idx` ON `limn_actions` (`account_id`,`commit_sha`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `limn_actions_node_idx` ON `limn_actions` (`account_id`,`github_node_id`);
--> statement-breakpoint
ALTER TABLE `reviews` ADD `limn_posted_by_user_id` integer REFERENCES users(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rv_limn_poster_idx` ON `reviews` (`limn_posted_by_user_id`);
--> statement-breakpoint
ALTER TABLE `review_comments` ADD `review_database_id` text;
--> statement-breakpoint
ALTER TABLE `commits` ADD `limn_pushed_by_user_id` integer REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `limn_merged_for_user_id` integer REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `limn_opened_for_user_id` integer REFERENCES users(id);
