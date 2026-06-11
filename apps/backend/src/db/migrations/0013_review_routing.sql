-- Claude Review routing (additive). Records the deterministic skip/diff_only/
-- worktree decision (review_mode) and its decision inputs (route_reason JSON) made
-- BEFORE the agent runs — so the diff-only fast path can be enforced and the
-- thresholds calibrated against the agent's own scopeUsed self-report. Both columns
-- are nullable; existing rows stay NULL until re-reviewed. SQLite-only: Claude
-- Review is force-disabled in cloud, so the Postgres claude_reviews table is never
-- populated (its baseline is regenerated separately via db:generate:pg).
ALTER TABLE `claude_reviews` ADD `review_mode` text;--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `route_reason` text;
