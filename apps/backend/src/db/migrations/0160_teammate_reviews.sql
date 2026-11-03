-- TEAMMATES' POSTED REVIEWS (docs/CLAUDE-REVIEW.md § Teammates' reviews). A review a teammate's Limn
-- POSTED to GitHub (summary + finding comments) is imported as a read-only `claude_reviews` row with
-- `kind = 'teammate'` (plain text, no CHECK — the column already exists), so every reader that means
-- "the reader's own runs" (`kind IS NULL`, or db/teammate-reviews.ts `ownRunsOnly`) leaves it out.
--   source_user_id         the teammate who posted it (users.id, the TRUE poster)
--   source_review_node_id  the GitHub review's node id — the import's idempotency key
--   teammate               JSON: what the hidden summary marker said (run kind, pair, runs, Limn
--                          version), the GitHub review's numeric id, and whether the head was inferred
-- Each finding is keyed on its GitHub comment's node id. Additive and nullable: no backfill (the next
-- walk of a PR imports what is there).
ALTER TABLE `claude_reviews` ADD `source_user_id` integer REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `source_review_node_id` text;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `teammate` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `cr_account_pr_source_review` ON `claude_reviews` (`account_id`,`pr_id`,`source_review_node_id`) WHERE `source_review_node_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `claude_review_findings` ADD `source_comment_node_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `crf_review_source_comment` ON `claude_review_findings` (`review_id`,`source_comment_node_id`) WHERE `source_comment_node_id` IS NOT NULL;
