-- LINEAR — the tracker's third reading adapter (docs/TRACKERS.md § Linear). The Postgres twin is
-- migrations-pg/0077_linear_links.sql.
--
-- A Linear workspace links a pull request to the Linear issues Linear's GitHub integration ATTACHED
-- it to (`attachmentsForURL` on the PR's GitHub URL — it sees the PR body, which lean storage never
-- keeps), in addition to the keys detection finds in the title and branch. That list is a fact the
-- view paths must read without calling Linear, so it is stored on the PR:
--
--   linear_links             JSON array of upper-cased `ENG-123` keys, in Linear's order.
--   linear_links_root        the Linear workspace they were read against (`https://linear.app/<key>`);
--                            a different current root means "never read" for this workspace.
--   linear_links_checked_at  when they were last read.
--
-- ⚠ NULL IS "NEVER READ", NOT "ATTACHED TO NOTHING" (`[]` is Linear's positive statement) — and for
-- Linear an unread PR still shows the tickets detection finds. Written ONLY by the tracker worker,
-- only for PRs in a workspace whose tracker is Linear with a saved key; the repo walk is unchanged,
-- so every other workspace pays nothing. Additive; no data to move.
ALTER TABLE `pull_requests` ADD `linear_links` text;
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `linear_links_root` text;
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `linear_links_checked_at` integer;
