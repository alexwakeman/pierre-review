-- Drop the "watched" concept — the Postgres twin of the sqlite migration 0046_drop_inbox_watch.
--
-- `repos.inbox_watch` / `repos.inbox_watch_started_at` were a second visibility axis on top of
-- "is this repo added to the account", quietly narrowing the Feed, recent activity, My Turn and
-- the Pro digest collection to a watched subset. With Workspaces the Workspace IS the scope, so
-- every repo in a Workspace is now fully live.
--
-- The property that mattered — adding a repo with 400 open PRs must not dump them all into My
-- Turn on day one — moves to `repos.created_at` (when the repo was ADDED), which already exists
-- and is NOT NULL, so there is no backfill.
--
-- `IF EXISTS` on both, so a database that somehow never had them replays cleanly.
ALTER TABLE "repos" DROP COLUMN IF EXISTS "inbox_watch";--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN IF EXISTS "inbox_watch_started_at";
