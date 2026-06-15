-- "Watch for inbox" per repo (additive). When `inbox_watch` is true, new open PRs by
-- others (opened on/after `inbox_watch_started_at`) surface in the My Turn inbox —
-- independent of timeline visibility and of removing the repo. `inbox_watch_started_at`
-- is set on the first watch and preserved across unwatch, so re-watching restores the
-- same window. Existing repos default to NOT watched (opt-in); new "yours" repos are
-- watched on add by the picker. Postgres baseline is regenerated separately via
-- db:generate:pg.
ALTER TABLE `repos` ADD `inbox_watch` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `inbox_watch_started_at` integer;
