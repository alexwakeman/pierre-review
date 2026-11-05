-- STILL-OPEN POSTS (2026-11-05; docs/CLAUDE-REVIEW.md § Still-open points). CORE, LOCAL ONLY (agentic).
--
--   claude_still_open_posts   NEW. The CLAIM RECORD for each GitHub write a posted Limn review makes
--                             about an earlier point it judged still open: a "Still open:" reply
--                             (once per thread per head), the unresolve of a resolved thread (ONCE PER
--                             THREAD, EVER) and a new inline thread continuing it (warning / blocker,
--                             once, ever). Inserted BEFORE the write — the unique (account_id,
--                             claim_key) is the compare-and-set — then settled; never retried.
-- Tenancy: the named COMPOSITE FK onto pull_requests (id, account_id), ON DELETE cascade — like
-- claude_thread_checks, so a deleted PR or repo takes its rows with it (no delete-path entry needed).
-- ⚠ Inserts use ON CONFLICT (account_id, claim_key) DO NOTHING: keep that target in step with the index.
CREATE TABLE IF NOT EXISTS `claude_still_open_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`thread_id` integer,
	`thread_node_id` text NOT NULL,
	`claim_key` text NOT NULL,
	`action` text NOT NULL,
	`review_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`severity` text,
	`comment_id` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `csop_pr_account_fk` FOREIGN KEY (`pr_id`,`account_id`) REFERENCES `pull_requests`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `csop_account_claim` ON `claude_still_open_posts` (`account_id`,`claim_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `csop_account_pr_idx` ON `claude_still_open_posts` (`account_id`,`pr_id`);
