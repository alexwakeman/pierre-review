-- THE CLAUDE SPEND BUDGET (core; packages/shared ai-budget.ts, ai/budget.ts).
--
-- accounts.ai_budget_settings: the optional per-machine budget that pauses AUTOMATIC model runs —
-- the subscription thresholds (5-hour / 7-day %), the subscription picked for the estimate, and the
-- API-key US$ budget. NULL = never set = off. One writer: PUT /api/ai/budget.
-- accounts.ai_budget_reading: the latest subscription usage reading (utilisation + reset time per
-- window), so a restart keeps it. Both nullable, no backfill.
ALTER TABLE `accounts` ADD `ai_budget_settings` text;
--> statement-breakpoint
ALTER TABLE `accounts` ADD `ai_budget_reading` text;
