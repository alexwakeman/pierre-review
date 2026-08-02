-- ML severity/category labels for BOT-authored text (CORE, free tier, no LLM). One row per
-- classified target — a review-thread comment, a PR comment, or a review BODY. Written only by
-- the background enrichment worker (sync/ml-enrichment.ts), which batches text to the
-- `severity-api` microservice from the sibling `pierre-ml` repo; read by the per-PR badge index
-- and the Bots severity rollup. Contract: docs/ML-SEVERITY.md.
--
-- `target_id` is NOT a foreign key: it lives in three different id spaces (review_comments.id /
-- pr_comments.id / reviews.id), so `target_kind` is part of the unique. Cleanup rides the
-- cascading `pr_id` FK — deleting a PR takes its labels with it — which is why this table is
-- deliberately absent from deleteRepo and deletePrSubtree (the `search_index` precedent).
-- The Postgres twin is migrations-pg/0034_ml_comment_labels.sql.
CREATE TABLE IF NOT EXISTS `ml_comment_labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` integer NOT NULL,
	`author_user_id` integer NOT NULL,
	`severity` text NOT NULL,
	`severity_ord` integer NOT NULL,
	`severity_prob` real NOT NULL,
	`categories` text NOT NULL,
	`category_probs` text NOT NULL,
	`is_summary` integer NOT NULL,
	`backend` text NOT NULL,
	`model_version` text NOT NULL,
	`body_hash` text NOT NULL,
	`target_created_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `mcl_account_target` ON `ml_comment_labels` (`account_id`,`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mcl_account_pr_idx` ON `ml_comment_labels` (`account_id`,`pr_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mcl_account_repo_author_idx` ON `ml_comment_labels` (`account_id`,`repo_id`,`author_user_id`);
