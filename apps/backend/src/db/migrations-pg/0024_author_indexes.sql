-- Author indexes for the contributor popover (`getUserStats`) — the Postgres twin of the
-- sqlite migration 0037_author_indexes. Its four counts drive from `pull_requests` (the only
-- side carrying `account_id`) and probe each child by `pr_id`, so the work scaled with the
-- ACCOUNT's PR count rather than with the person being asked about. No table had an
-- `author_id` index before this. Purely additive.
CREATE INDEX IF NOT EXISTS "pr_author_idx" ON "pull_requests" ("author_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rv_author_idx" ON "reviews" ("author_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prc_author_idx" ON "pr_comments" ("author_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_author_idx" ON "review_comments" ("author_id");
