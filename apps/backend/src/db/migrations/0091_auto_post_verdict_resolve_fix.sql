-- AUTO-POST CI CAUSES · AUTO VERDICT · AUTO RESOLVE · AUTO FIX SETTINGS (docs/CLAUDE-REVIEW.md
-- § Auto-posting, § AI Fix). The Postgres twin is migrations-pg/0078_auto_post_verdict_resolve_fix.sql.
-- Additive; no data to move. (The verdict and resolve switches ride the existing
-- `workspaces.auto_post_settings` overrides JSON — no column for them.)
--
--   ci_review_items.confidence        Claude's 0-100 confidence in a cause. NULL = not reported
--                                     (every older row, every not_checked item).
--   ci_reviews.auto_post              CiAutoPostRecord JSON — what CI auto-posting did with an AUTO
--                                     run. NULL = never claimed; claimed by compare-and-set from
--                                     NULL BEFORE any GitHub write, never retried.
--   claude_review_findings.auto_resolved_at  when auto-resolve resolved this finding's thread.
--   claude_review_findings.auto_resolve      FindingAutoResolveRecord JSON — claimed from NULL,
--                                     once per finding, never retried.
--   workspaces.auto_fix_settings      StoredAutoFixSettings JSON, OVERRIDES ONLY (NULL = defaults:
--                                     every section but style bots, no push).
ALTER TABLE `ci_review_items` ADD `confidence` integer;
--> statement-breakpoint
ALTER TABLE `ci_reviews` ADD `auto_post` text;
--> statement-breakpoint
ALTER TABLE `claude_review_findings` ADD `auto_resolved_at` integer;
--> statement-breakpoint
ALTER TABLE `claude_review_findings` ADD `auto_resolve` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `auto_fix_settings` text;
