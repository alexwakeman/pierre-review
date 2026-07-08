-- Per-account monthly SUMMARY-AI credit allowance override (metered cloud plan). Nullable,
-- no default: null = use the plan default (2,500 for a paid cloud account); local/unlimited
-- accounts ignore it. A forward hook for top-ups / alternate plans without another migration.
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
ALTER TABLE `accounts` ADD `ai_credit_allowance` integer;
