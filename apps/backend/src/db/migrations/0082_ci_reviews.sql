-- CI REVIEW (local-only feature, like the rest of Claude Review): a separate Claude run that explains
-- why checks FAILED on a PR's head, split out of the PR review's own run. Two tables:
--   ci_reviews       one row per run (history kept). Keyed by (pr, head, sorted failing check names):
--                    `failing_key` is what the run read live, `trigger_key` the synced set that
--                    started it.
--   ci_review_items  one row per failing check: Claude's cause, or the server's not-checked reason.
-- Run ids arrive in request paths, so the item table's tenancy is STRUCTURAL: a composite FK against
-- ci_reviews(id, account_id), whose parent key `ci_reviews_id_account` is created here; the run's PR
-- against pull_requests(id, account_id). Both delete paths (deleteRepo, retention's deletePrSubtree)
-- and eraseAccountData delete these rows explicitly. `claude_reviews.ci_failures` becomes LEGACY
-- (read-only); nothing here touches it. The Postgres twin is migrations-pg/0069_ci_reviews.sql.
CREATE TABLE IF NOT EXISTS `ci_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`failing_key` text,
	`trigger_key` text,
	`failing_checks` text,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`error` text,
	`refused` text,
	`ci_state` text,
	`summary` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `cir_pr_account_fk` FOREIGN KEY (`pr_id`,`account_id`) REFERENCES `pull_requests`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cir_account_pr_created_idx` ON `ci_reviews` (`account_id`,`pr_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cir_account_ws_created_idx` ON `ci_reviews` (`account_id`,`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ci_reviews_id_account` ON `ci_reviews` (`id`,`account_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ci_review_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ci_review_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`ref` text,
	`check_name` text NOT NULL,
	`job_id` integer,
	`step` text,
	`url` text,
	`sent` integer DEFAULT false NOT NULL,
	`carried` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`not_checked_reason` text,
	`cause` text,
	`explanation` text,
	`category` text,
	`fixable_in_pr` integer,
	`path` text,
	`line` integer,
	`suggestion` text,
	`related_files` text,
	`assessed_at_head` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `ciri_review_account_fk` FOREIGN KEY (`ci_review_id`,`account_id`) REFERENCES `ci_reviews`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ciri_review_idx` ON `ci_review_items` (`ci_review_id`);
