-- THE REVIEW PLAN (2026-11-01; docs/CLAUDE-REVIEW.md § The review plan). Additive, nullable.
--   claude_reviews.coverage   the changed files ranked by code before the run (review/claude-review/
--                             worklist.ts) and what the run reported on each: issues, no_issues or
--                             not_reviewed. NULL = no plan (an older row, a skip, a failed run).
ALTER TABLE `claude_reviews` ADD `coverage` text;
