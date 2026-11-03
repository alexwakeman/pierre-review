-- "REVIEW AND POST" (docs/CLAUDE-REVIEW.md § Auto-posting, "A manual Review and post"). A MANUAL run
-- the reader started with the split button's "Review and post" posts itself when it succeeds (a pair:
-- when both halves have ended), under the auto-post rules. Stored on the run so the post happens at
-- its end, and so a pair a restart interrupted still posts when the boot ends it.
--   claude_reviews.post_on_finish   1 = post when the run ends; NULL = keep it in Limn (every other run).
-- Additive and nullable: no backfill.
ALTER TABLE `claude_reviews` ADD `post_on_finish` integer;
