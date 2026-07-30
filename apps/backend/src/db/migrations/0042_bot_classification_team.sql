-- Per-TEAM bot classification + the quality-check ROLE, SQLite / local mode.
-- Postgres twin: migrations-pg/0029_bot_classification_team.sql.
--
-- Two orthogonal additions to `bot_review_classification`:
--
-- 1. `team_id` — "is this login a bot, and what kind" becomes a PER-TEAM answer. NOT NULL with
--    the sentinel 0, never nullable: a UNIQUE index over a NULLable column dedupes in NEITHER
--    dialect (NULLs compare distinct), so a nullable key would silently permit duplicate rows
--    per (account, author) and leave the upsert's conflict target unreachable. 0 is BOTH the
--    "No team" scope AND the inheritance ROOT — resolution is `explicit team row → the team-0
--    row → auto-detect`. No FK to `teams`, because 0 is not a team id and an FK would reject
--    every default row (deleteTeam must therefore delete this table's rows by hand).
--
-- 2. `role` — 'review' | 'quality_check'. Static analysis / coverage / lint (SonarQube,
--    Codecov, Hound) posts review comments and IS automated, but is not reviewing; counting it
--    as a reviewer is what makes the Bot-ROI numbers lie. Deliberately NOT a new
--    AutomatedReviewerKind: role and vendor identity are orthogonal, and getBenchmarkContributions
--    filters kinds with a RUNTIME string test, so a new kind member would be shipped to the
--    cross-org benchmark as a named review-bot cohort.
--
-- DATA MIGRATION. Both columns carry constant defaults, so every existing row lands at
-- (team_id 0, role 'review') — which is exactly today's behaviour, preserved byte-for-byte in
-- every scope, with a newly created team inheriting the account default for free. That is why
-- there is no team fan-out: copying each row to every team would duplicate forever, would make
-- editing "No team" silently stop affecting an existing team, and would give post-migration
-- teams different semantics from pre-migration ones.
--
-- The one real backfill is the role seed below: AUTO rows for known quality-check logins are
-- re-roled in place, so an account that already classified SonarQube (today it resolves to
-- `in_house` via the githubType step — the exact miscount this feature fixes) sees correct ROI
-- on first load instead of waiting for a re-classification pass. MANUAL rows are never touched.
ALTER TABLE `bot_review_classification` ADD `team_id` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_review_classification` ADD `role` text DEFAULT 'review' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `brc_account_author`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `brc_account_team_author` ON `bot_review_classification` (`account_id`,`team_id`,`author_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `brc_account_team_idx` ON `bot_review_classification` (`account_id`,`team_id`);--> statement-breakpoint
UPDATE `bot_review_classification`
SET `role` = 'quality_check'
WHERE `source` <> 'manual'
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE lower(`github_login`) IN (
      'sonarqubecloud', 'sonarqubecloud[bot]',
      'sonarcloud', 'sonarcloud[bot]',
      'codecov', 'codecov[bot]',
      'codeclimate', 'codeclimate[bot]',
      'codefactor-io', 'codefactor-io[bot]',
      'houndci-bot', 'houndci-bot[bot]',
      'coveralls', 'coveralls[bot]',
      'codacy-bot', 'codacy-bot[bot]'
    )
  );
