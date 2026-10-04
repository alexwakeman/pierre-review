-- TICKET REVIEW (local-only feature, like the rest of Claude Review): one review per TICKET across
-- every pull request that names it, split out of the PR review's own run. Three tables:
--   ticket_reviews         one row per run (history kept; no unique on the ident)
--   ticket_review_members  the exact PR set a run judged (currency + "runs this PR is on")
--   ticket_review_items    the unmet / partly met criteria and missing items (what can be posted)
-- Run and item ids arrive in request paths, so the children's tenancy is STRUCTURAL: composite FKs
-- against ticket_reviews(id, account_id), whose parent key `ticket_reviews_id_account` is created
-- here; a member's PR against pull_requests(id, account_id). Both delete paths (deleteRepo,
-- retention's deletePrSubtree) and eraseAccountData delete these rows explicitly.
-- `claude_reviews.ticket` / `ticket_assessment` and the `story_*` finding columns become LEGACY
-- (read-only); nothing here touches them. The Postgres twin is migrations-pg/0067_ticket_reviews.sql.
CREATE TABLE IF NOT EXISTS `ticket_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ticket_ident` text NOT NULL,
	`ticket_key` text,
	`ticket_title` text,
	`ticket_snapshot` text,
	`ticket_hash` text,
	`fingerprint` text,
	`pr_count` integer,
	`origin_pr_id` integer,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`error` text,
	`refused` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`alignment` text,
	`summary` text,
	`assessment` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tr_account_ident_created_idx` ON `ticket_reviews` (`account_id`,`ticket_ident`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tr_account_ws_created_idx` ON `ticket_reviews` (`account_id`,`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ticket_reviews_id_account` ON `ticket_reviews` (`id`,`account_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ticket_review_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_review_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`pr_state` text NOT NULL,
	`checked_out` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `trm_review_account_fk` FOREIGN KEY (`ticket_review_id`,`account_id`) REFERENCES `ticket_reviews`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `trm_pr_account_fk` FOREIGN KEY (`pr_id`,`account_id`) REFERENCES `pull_requests`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trm_account_pr_idx` ON `ticket_review_members` (`account_id`,`pr_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trm_review_idx` ON `ticket_review_members` (`ticket_review_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ticket_review_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_review_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`ref` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`owner_pr_id` integer,
	`path` text,
	`line` integer,
	`posted_pr_id` integer,
	`posted_comment_id` text,
	`posted_at` integer,
	`prior_item_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `tri_review_account_fk` FOREIGN KEY (`ticket_review_id`,`account_id`) REFERENCES `ticket_reviews`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tri_review_idx` ON `ticket_review_items` (`ticket_review_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tri_account_owner_idx` ON `ticket_review_items` (`account_id`,`owner_pr_id`);
