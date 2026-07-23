-- Cross-team full-text search index (CORE, no AI). One row per searchable text unit — a PR
-- (title + description), a review body, a review-comment (carrying its thread_id for deep-linking),
-- or a PR-comment. Populated inside persistPr() (delete-by-pr_id then insert) and backfilled from
-- already-stored data at startup. Denormalized account_id is the tenant anchor; matching is portable
-- case-insensitive substring (lower(body) LIKE …). FKs cascade so a repo/PR delete cleans up.
-- The Postgres baseline is maintained separately (migrations-pg/).
CREATE TABLE `search_index` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`thread_id` integer,
	`author_id` integer,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `search_account_repo_idx` ON `search_index` (`account_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX `search_pr_idx` ON `search_index` (`pr_id`);
