-- AN AUTO REVIEW THIS LIMN SKIPPED, SAID ON THE PR (docs/CLAUDE-REVIEW.md § Team claims → The skipped
-- line). When the reader's Limn does not start an auto review it would otherwise run (the AI budget is
-- used, the workspace's daily limit is reached, the provider is over its usage limit, AI is not signed
-- in), it posts ONE green `limn/review-<provider>` line on the head. One row per (account, PR, head,
-- provider, reason), claimed BEFORE the GitHub write: at most once, never retried. Additive.
CREATE TABLE `team_claim_skip_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`provider` text NOT NULL,
	`reason` text NOT NULL,
	`state` text NOT NULL,
	`description` text,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_claim_skip_lines_key` ON `team_claim_skip_lines` (`account_id`,`pr_id`,`head_sha`,`provider`,`reason`);
