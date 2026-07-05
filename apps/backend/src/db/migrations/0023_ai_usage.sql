-- AI-spend ledger (additive). Append-only: one row per billable AI operation (LLM
-- completion or Agent-SDK run) so month-to-date usage is summable across features (the
-- per-feature cost columns upsert-overwrite). Surfaced only as credits, never dollars.
-- `seam` = summary (cheap completions) | agent (Agent-SDK runs). No FK on pr_id/repo_id
-- so the ledger survives PR/repo pruning. Postgres baseline regenerated via `db:generate:pg`.
CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`seam` text NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`pr_id` integer,
	`repo_id` integer,
	`occurred_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `au_account_occurred` ON `ai_usage` (`account_id`,`occurred_at`);
