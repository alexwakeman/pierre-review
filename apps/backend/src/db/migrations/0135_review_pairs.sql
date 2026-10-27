-- CLAUDE + CODEX PAIRS (docs/CLAUDE-REVIEW.md § Claude + Codex). A pair is two ordinary runs: Claude
-- first, then Codex with Claude's findings as already raised. `pair_id` = the FIRST run's id, on both
-- rows; `pair_role` = 'first' | 'second'; `pair_dropped` = how many of the second run's findings
-- repeated a first-run finding and were dropped in code (second run only). NULL on every other row.
ALTER TABLE `claude_reviews` ADD `pair_id` integer;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `pair_role` text;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `pair_dropped` integer;
--> statement-breakpoint
-- Who runs a workspace's AUTO reviews: NULL = the default provider (Settings → AI); 'both' = a pair.
ALTER TABLE `workspaces` ADD `auto_review_providers` text;
