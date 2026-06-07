-- Make review_comments.body and pr_comments.body NULLABLE for lean storage
-- (config.persistBodies false, now the default in both modes): the full body is
-- dropped from storage and hydrated on demand, leaving review_comments.excerpt
-- (from 0009) as the kept preview. SQLite can't drop a NOT NULL via ALTER, so the
-- two tables are rebuilt. This is safe: no other table has a foreign key pointing
-- at them, and the copied data already satisfies their own (unchanged) outbound
-- FKs. The rebuilt tables keep the excerpt column and every current index.
CREATE TABLE `__new_review_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_node_id` text NOT NULL,
	`thread_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`author_id` integer,
	`body` text,
	`excerpt` text,
	`diff_hunk` text,
	`database_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `review_threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_review_comments` (`id`, `github_node_id`, `thread_id`, `pr_id`, `author_id`, `body`, `excerpt`, `diff_hunk`, `database_id`, `created_at`)
	SELECT `id`, `github_node_id`, `thread_id`, `pr_id`, `author_id`, `body`, `excerpt`, `diff_hunk`, `database_id`, `created_at` FROM `review_comments`;
--> statement-breakpoint
DROP TABLE `review_comments`;
--> statement-breakpoint
ALTER TABLE `__new_review_comments` RENAME TO `review_comments`;
--> statement-breakpoint
CREATE INDEX `rc_thread_idx` ON `review_comments` (`thread_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `rc_pr_node` ON `review_comments` (`pr_id`,`github_node_id`);
--> statement-breakpoint
CREATE TABLE `__new_pr_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_node_id` text NOT NULL,
	`pr_id` integer NOT NULL,
	`author_id` integer,
	`body` text,
	`database_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_pr_comments` (`id`, `github_node_id`, `pr_id`, `author_id`, `body`, `database_id`, `created_at`)
	SELECT `id`, `github_node_id`, `pr_id`, `author_id`, `body`, `database_id`, `created_at` FROM `pr_comments`;
--> statement-breakpoint
DROP TABLE `pr_comments`;
--> statement-breakpoint
ALTER TABLE `__new_pr_comments` RENAME TO `pr_comments`;
--> statement-breakpoint
CREATE INDEX `prc_pr_idx` ON `pr_comments` (`pr_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `prc_pr_node` ON `pr_comments` (`pr_id`,`github_node_id`);
