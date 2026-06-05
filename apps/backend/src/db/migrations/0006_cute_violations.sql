CREATE TABLE `claude_review_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`path` text NOT NULL,
	`line` integer,
	`side` text DEFAULT 'RIGHT' NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`suggestion` text,
	`anchored` integer DEFAULT true NOT NULL,
	`included` integer DEFAULT false NOT NULL,
	`posted_at` integer,
	`github_comment_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `claude_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `crf_review_idx` ON `claude_review_findings` (`review_id`);--> statement-breakpoint
CREATE TABLE `claude_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pr_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`scope` text,
	`summary` text,
	`verdict` text,
	`user_body` text,
	`user_verdict` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`error` text,
	`excluded_files` text,
	`posted_review_id` text,
	`posted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cr_pr_idx` ON `claude_reviews` (`pr_id`);--> statement-breakpoint
CREATE INDEX `cr_pr_sha_idx` ON `claude_reviews` (`pr_id`,`head_sha`);