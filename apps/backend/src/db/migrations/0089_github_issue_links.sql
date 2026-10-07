-- GITHUB ISSUES — the tracker's second reading adapter (docs/TRACKERS.md § GitHub Issues). The
-- Postgres twin is migrations-pg/0076_github_issue_links.sql.
--
-- A GitHub Issues workspace links a pull request to the issues it CLOSES — GitHub's own
-- `closingIssuesReferences` ("Fixes #12", "Closes owner/repo#12", a Development-panel link), never
-- a bare "#12" mention. That list is a fact about the PR that the view paths (the PR pane's chips,
-- the Open PRs ticket row) must read without calling GitHub, so it is stored on the PR:
--
--   closing_issues             JSON array of lower-cased `owner/repo#12` keys, in GitHub's order.
--   closing_issues_checked_at  when it was last read.
--
-- ⚠ NULL IS "NEVER READ", NOT "CLOSES NOTHING" (`[]` is GitHub's positive statement). Both are
-- written ONLY by the tracker worker's targeted `nodes(ids:)` step, and only for PRs in a workspace
-- whose tracker is GitHub Issues — the repo walk's query is unchanged, so every other workspace pays
-- nothing for this. Additive; no data to move.
ALTER TABLE `pull_requests` ADD `closing_issues` text;
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `closing_issues_checked_at` integer;
