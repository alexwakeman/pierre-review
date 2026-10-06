-- AUTO-POSTING OF CLAUDE REVIEW OUTPUT (review/claude-review/auto-post.ts, review/ticket-review/
-- auto-post.ts). A per-workspace master switch, OFF for every workspace existing and new, plus the
-- per-run records of what was posted and the per-item "posted automatically" flag.
--   workspaces.auto_post_enabled      NULL/false = off. Nullable, no default: no insert names it.
--   workspaces.auto_post_settings     JSON, OVERRIDES ONLY ({ scope?, kinds? }); NULL = defaults.
--   claude_reviews.auto_post          JSON ClaudeAutoPostRecord; NULL = never looked at.
--   claude_review_findings.posted_auto  true = posted by auto-posting.
--   ticket_reviews.auto_post          JSON TicketAutoPostRecord; NULL = never looked at.
--   ticket_review_items.posted_auto   true = posted by auto-posting (carried with the posting).
-- The Postgres twin is migrations-pg/0074_auto_post.sql.
ALTER TABLE `workspaces` ADD `auto_post_enabled` integer;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `auto_post_settings` text;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `auto_post` text;
--> statement-breakpoint
ALTER TABLE `claude_review_findings` ADD `posted_auto` integer;
--> statement-breakpoint
ALTER TABLE `ticket_reviews` ADD `auto_post` text;
--> statement-breakpoint
ALTER TABLE `ticket_review_items` ADD `posted_auto` integer;
