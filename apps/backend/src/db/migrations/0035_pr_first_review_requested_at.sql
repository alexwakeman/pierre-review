-- Review-pickup support: store the earliest review-request time (first ReviewRequestedEvent) so
-- we can trend request→first-review latency. Nullable (null = never requested / pre-existing PRs
-- until the next sync backfills it from the timeline). Additive.
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
ALTER TABLE `pull_requests` ADD `first_review_requested_at` integer;
