-- CHECK THREADS (2026-10-18; docs/CLAUDE-REVIEW.md § Check threads). CORE, free, LOCAL ONLY (agentic).
-- The Postgres twin is migrations-pg/0109_claude_thread_checks.sql.
--
--   claude_thread_checks   NEW. ONE row per light, threads-only Claude pass over a PR (a click on
--                          "Check threads", or the auto-review sweeper on a comment burst). It judges
--                          ONLY the threads that changed since their last judgement and stores the
--                          WHOLE reconciled set (changed + carried) in `thread_assessments`, so the
--                          thread cards read the newer of this and the latest Claude review per thread.
--                          `comments_through` is the newest qualifying comment it covered (the auto
--                          re-review key, like claude_reviews.comments_through).
-- Tenancy: the named COMPOSITE FK onto pull_requests (id, account_id), ON DELETE cascade — exactly
-- like ci_reviews, so a deleted PR or repo takes its checks with it (no delete-path entry needed).
-- No unique index (one row per run), so no ON CONFLICT target to keep in step.
CREATE TABLE IF NOT EXISTS `claude_thread_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`threads_sent` integer,
	`thread_assessments` text,
	`comments_through` integer,
	`refused` text,
	`error` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `ctc_pr_account_fk` FOREIGN KEY (`pr_id`,`account_id`) REFERENCES `pull_requests`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ctc_account_pr_created_idx` ON `claude_thread_checks` (`account_id`,`pr_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ctc_account_ws_created_idx` ON `claude_thread_checks` (`account_id`,`workspace_id`,`created_at`);
