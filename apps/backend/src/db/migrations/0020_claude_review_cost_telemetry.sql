-- Claude Review cost telemetry (additive). Records the cache-token split (a
-- multi-turn run's input is mostly cache reads — the dominant cost the plain
-- input_tokens column hid) plus the full noise-stripped diff size and whether the
-- feature-flagged diff-size cap truncated the prompt (so capped vs uncapped runs can
-- be cost-compared). All nullable; existing rows stay NULL. SQLite-only: Claude
-- Review is force-disabled in cloud, so the Postgres claude_reviews table is never
-- populated (its baseline is regenerated separately via db:generate:pg).
ALTER TABLE `claude_reviews` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `cache_creation_tokens` integer;--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `diff_bytes` integer;--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `diff_capped` integer;
