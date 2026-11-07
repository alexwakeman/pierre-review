-- PUSH SUMMARIES (2026-11-06; docs/CLAUDE-REVIEW.md § Push summaries). CORE, additive.
--
--   claude_reviews.push_summary           NEW, nullable text: a FULL review's short summary of the
--                                         pushes it covers (what changed, and how it bears on the
--                                         open findings and threads). NULL on every older row, on a
--                                         replies pass, and on a run at an unmoved head.
--   claude_reviews.push_summary_from_sha  NEW, nullable text: where that range starts, EXCLUSIVE —
--                                         the previous full review's head. NULL with a summary = from
--                                         the PR's first commit. The range ends at the row's head_sha.
ALTER TABLE `claude_reviews` ADD `push_summary` text;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `push_summary_from_sha` text;
