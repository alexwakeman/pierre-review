-- LIMN FINDINGS ARE BOTS (2026-11-01; docs/CLAUDE-REVIEW.md § Limn findings are bots). Additive.
--   review_comments.limn_posted_by_user_id   the person who posted a Limn finding comment; the
--   pr_comments.limn_posted_by_user_id       row's author_id then holds the per-poster bot user
--                                            `limn:<login>`. NULL on every other comment.
-- No backfill here: the boot reconcile (db/limn-bots.ts `reconcileLimnFindingAuthors`) re-attributes
-- existing rows, idempotently, because the predicate (shared `limnFindingPost`) is code.
ALTER TABLE `review_comments` ADD `limn_posted_by_user_id` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `pr_comments` ADD `limn_posted_by_user_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rc_limn_poster_idx` ON `review_comments` (`limn_posted_by_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prc_limn_poster_idx` ON `pr_comments` (`limn_posted_by_user_id`);
