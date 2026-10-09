-- GITHUB ISSUES AS THE AUTOMATIC DEFAULT TRACKER (docs/TRACKERS.md § Automatic default). The
-- Postgres twin is migrations-pg/0081_repo_uses_github_issues.sql. Additive.
--
--   repos.uses_github_issues          NULL = never answered; true = issues ENABLED and at least one
--                                     issue linked to a PR in the last 90 days. Asked of GitHub at
--                                     most once a day, only for repos in a workspace with no stored
--                                     tracker choice (tracker/github/issues-usage.ts).
--   repos.github_issues_checked_at    the last attempt.
--
-- `workspace_trackers.provider` gains a STORED "None": 'none'. NULL (or no row) now means "no
-- choice stored", which follows the automatic default.
--
-- ⚠ ONLY AN ALL-NULL ROW BECOMES 'none'. A NULL provider is NOT proof of a chosen None: the legacy
-- move (tracker/legacy-import.ts) copies any plugin row with ANY setting set, so a workspace that only
-- ever set a match scope or project keys arrived with provider NULL, and a PUT naming no provider
-- kept it NULL. The one row nothing but a None save could write is the row with EVERY column NULL
-- (the Settings None save sends `{provider: null}` alone). That row becomes 'none'; every other
-- NULL-provider row stays unchosen and follows the automatic default. Cost accepted: a None saved
-- over a former Jira/Linear setup (its URL kept) reads as unchosen after the upgrade. The legacy
-- move leaves its NULL providers NULL, so both upgrade orders agree (a legacy row always has a
-- value set, so this UPDATE never matches it).
ALTER TABLE `repos` ADD `uses_github_issues` integer;
--> statement-breakpoint
ALTER TABLE `repos` ADD `github_issues_checked_at` integer;
--> statement-breakpoint
UPDATE `workspace_trackers` SET `provider` = 'none' WHERE `provider` IS NULL AND `base_url` IS NULL AND `project_keys` IS NULL AND `match_scope` IS NULL AND `auth_email` IS NULL AND `auth_token` IS NULL;
