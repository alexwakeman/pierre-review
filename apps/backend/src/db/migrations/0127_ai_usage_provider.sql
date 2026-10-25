-- THE AI PROVIDER SEAM (ai/provider.ts; docs/CODEX-PLAN.md § 8.1): the spend ledger learns which
-- provider spent each row, so the budget's folds can sum ONE provider's spend.
--
-- ai_usage.provider: 'claude' | 'codex'. NOT NULL with DEFAULT 'claude' — every row written before
-- this column existed was Claude's, and SQLite fills the default into existing rows on ADD COLUMN.
-- ai_usage.share_pct: a subscription run's rise in its provider's weekly window, in percent, when
-- the provider reports one (a Codex ChatGPT-login run). Nullable; NULL for every Claude row.
-- input_tokens / output_tokens stay nullable (a cancelled run has no token figure).
ALTER TABLE `ai_usage` ADD `provider` text DEFAULT 'claude' NOT NULL;
--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `share_pct` real;
