-- Resolution-latency support: record WHEN a review thread was first observed resolved. Nullable
-- (unknown for threads already resolved at first sight); stamped by sync only on a witnessed
-- unresolved→resolved transition. Additive — the backfill is a no-op (existing resolved threads
-- keep a null resolvedAt; the metric only counts resolves observed going forward).
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
ALTER TABLE `review_threads` ADD `resolved_at` integer;
