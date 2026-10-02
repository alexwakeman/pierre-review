-- CLAUDE REVIEW: A FINDING'S LENS, AND REVIEW MEMORY DELETED.
--
-- claude_review_findings.lens: which specialist angle raised the finding — 'design', 'tests',
-- 'impact', 'accessibility', 'security' or 'performance' — set on deep (worktree) reviews, where
-- the lead agent may consult up to five specialist sub-agents. NULL is a general finding, and every
-- older row is NULL (no backfill).
--
-- review_learnings is DROPPED. Review memory (capture of what the reader did with each finding,
-- the "past reviews" panel and the prompt block built from it) was removed: it never improved a
-- review. Adopted into core by 0074; the plugin's own DDL for it was already stripped, so nothing
-- recreates it. DROP TABLE takes its five rl_* indexes with it.
-- The Postgres twin is migrations-pg/0062_review_lens_drop_learnings.sql.
ALTER TABLE `claude_review_findings` ADD `lens` text;
--> statement-breakpoint
DROP TABLE IF EXISTS `review_learnings`;
