-- RELEASES: A FAILED RELEASE TAG NO LONGER HOLDS ITS NAME (2026-11-15; docs/RELEASES.md § Implementation).
-- CORE. The unique (account, repo, release_tag_name) on release_items made a FAILED or REFUSED tag
-- write hold the name for good: every later press for that version was told "already made". The
-- name is now held only by a LIVE row (pending / claimed / done) — a partial unique index, declared
-- here only (like `workspaces_one_default`). A failed or refused row stays as that release's history;
-- a new press is a new claim on a new row (still claimed before the write, never retried).
DROP INDEX IF EXISTS `release_items_account_repo_tag`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `release_items_account_repo_tag_live` ON `release_items` (`account_id`,`repo_id`,`release_tag_name`) WHERE `tag_state` IN ('pending', 'claimed', 'done');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `release_items_account_repo_tag_idx` ON `release_items` (`account_id`,`repo_id`,`release_tag_name`);
