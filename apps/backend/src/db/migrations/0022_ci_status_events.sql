-- CI status transition history (additive). Append-only log of a PR head's CI-state
-- transitions, recorded during sync when the CI rollup / failing-check set / head SHA
-- changes. Powers real CI failure-resolution time + failure-reason-by-stage metrics
-- (the current pull_requests.ci_status is only a snapshot; check_runs is lean-gated).
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
CREATE TABLE `ci_status_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`failing_checks` text,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cse_account_pr_observed` ON `ci_status_events` (`account_id`,`pr_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `cse_account_repo_observed` ON `ci_status_events` (`account_id`,`repo_id`,`observed_at`);
