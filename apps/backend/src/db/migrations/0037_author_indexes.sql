-- Author indexes for the contributor popover (`getUserStats`).
--
-- Its four counts all drive from `pull_requests` (the only side carrying `account_id`) and
-- probe each child table by `pr_id`, so the work scaled with the ACCOUNT's PR count rather
-- than with the person being asked about: measured ~55ms on a 6k-PR local DB for a busy
-- reviewer AND for one with zero reviews. better-sqlite3 is synchronous, so that is 55ms of
-- blocked event loop per popover open, and it grows with the tenant.
--
-- No table had an `author_id` index before this. Indexing the selective side lets the planner
-- drive from the user instead. Purely additive — no column or constraint changes.
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
CREATE INDEX IF NOT EXISTS `pr_author_idx` ON `pull_requests` (`author_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rv_author_idx` ON `reviews` (`author_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prc_author_idx` ON `pr_comments` (`author_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rc_author_idx` ON `review_comments` (`author_id`);
