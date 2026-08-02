-- TEAMS BECOME WORKSPACES, AND A REPO GETS EXACTLY ONE. SQLite / local mode; Postgres twin:
-- migrations-pg/0031_workspaces.sql. Migration 0045 then collapses the two bot tables onto the
-- workspace key — read them together, they are one change in two steps:
--
--   0044  RE-HOME   repo grouping:  teams (m2m)  →  workspaces (1:N), + a Default per account
--   0045  COLLAPSE  the bot object: repo_reviewers + account_reviewers → workspace_reviewers
--
-- WHY A WORKSPACE. `teams` was a many-to-many bag of repos alongside four scope sentinels
-- ('all' / 'none' / 'teams' / a set), which made "which repos am I looking at" a five-branch
-- question with three independent parsers. A workspace is the ONE scope: a repo belongs to
-- EXACTLY ONE of them, so there is nothing to canonicalise and no "in no team" bucket.
--
-- WORKSPACE IDS ARE THE OLD TEAM IDS. Preserved deliberately: a URL, a bookmark, a persisted
-- filter and (after the plugin's own 0020) a cache row all carry the number, and renumbering
-- would silently repoint them at a different repo set.
--
-- ⚠ THE ONE THING THAT DIFFERS BETWEEN THE DIALECTS IS THE SEQUENCE. SQLite AUTOINCREMENT tracks
-- max(rowid) ever seen, so an explicit-id INSERT advances it and the Default rows below get fresh
-- ids for free. Postgres `serial` does NOT advance on an explicit-id INSERT, so the twin must
-- setval() between the two inserts or the very next workspace collides with a preserved team id.
--
-- ── ON RE-RUNNING THIS FILE ─────────────────────────────────────────────────────────────────
-- Every statement is IF NOT EXISTS / ON CONFLICT DO NOTHING down to the two DROPs, and the legacy
-- source tables are STUBBED below, so the backfill is still a legal, empty statement on a database
-- where they have already gone. That is the SQLite answer to the pg twin's `to_regclass` guard,
-- which exists for the same reason: this file ends by dropping the tables its own backfill reads.

-- THE LEGACY SOURCES, STUBBED — no-ops on every database this migration is meant for.
CREATE TABLE IF NOT EXISTS `teams` (
	`id` integer, `account_id` integer, `name` text, `created_at` integer
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_repos` (
	`id` integer, `account_id` integer, `team_id` integer, `repo_id` integer, `created_at` integer
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspaces_account_name` ON `workspaces` (`account_id`,`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspaces_account_idx` ON `workspaces` (`account_id`);--> statement-breakpoint
-- The parent key for the composite FKs on workspace_repos + workspace_reviewers. NOT a lookup
-- index — `id` is already the PK — and both dialects require a unique index over the parent-key
-- columns before such an FK is legal. Drop it and both composite FKs become unexpressible.
CREATE UNIQUE INDEX IF NOT EXISTS `workspaces_id_account` ON `workspaces` (`id`,`account_id`);--> statement-breakpoint

-- 1. One workspace per existing team, IDS PRESERVED.
INSERT INTO `workspaces` (`id`, `account_id`, `name`, `is_default`, `created_at`)
SELECT `id`, `account_id`, `name`, 0, `created_at` FROM `teams`
 WHERE true
ON CONFLICT (`id`) DO NOTHING;--> statement-breakpoint

-- 2. A Default workspace for EVERY account, including accounts that never had a team.
--    The three-level name CASE exists because `workspaces_account_name` is unique and a user may
--    already own a team called "Default". The third form embeds the account id, so it cannot
--    collide with the first two for the same account.
INSERT INTO `workspaces` (`account_id`, `name`, `is_default`, `created_at`)
SELECT a.`id`,
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM `workspaces` w WHERE w.`account_id` = a.`id` AND w.`name` = 'Default')
           THEN 'Default'
         WHEN NOT EXISTS (SELECT 1 FROM `workspaces` w WHERE w.`account_id` = a.`id` AND w.`name` = 'Default workspace')
           THEN 'Default workspace'
         ELSE 'Default (workspace ' || a.`id` || ')'
       END,
       1, unixepoch()
  FROM `accounts` a
 WHERE NOT EXISTS (SELECT 1 FROM `workspaces` w WHERE w.`account_id` = a.`id` AND w.`is_default` = 1);--> statement-breakpoint

-- 2b. ONE DEFAULT PER ACCOUNT, AS A DATABASE FACT. Created after the backfill so a hand-corrupted
--     database fails on a statement whose meaning is obvious. This is what makes
--     ensureDefaultWorkspace's "INSERT … ON CONFLICT DO NOTHING then re-SELECT" race-safe: it runs
--     on effectively every request, and two concurrent calls for an account with no default would
--     otherwise both SELECT nothing and both INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS `workspaces_one_default` ON `workspaces` (`account_id`) WHERE `is_default` = 1;--> statement-breakpoint

-- EXACTLY ONE WORKSPACE PER REPO, AS A DATABASE FACT: the unique on (account_id, repo_id) is what
-- makes assigning a repo elsewhere an UPSERT, i.e. a MOVE, with no code path able to produce a
-- second membership row. `repo_id` alone would do (repos.id is a global PK) — account_id rides in
-- the key so the isolation predicate and the conflict target are the same columns, the same
-- discipline `repo_reviewers` used.
--
-- WHY A TABLE AND NOT A `repos.workspace_id` COLUMN. SQLite cannot ADD a CONSTRAINT to an existing
-- table and cannot cheaply make an existing column NOT NULL; a NOT NULL FK column on `repos` means
-- rebuilding `repos` (create-copy-drop-rename) under `foreign_keys=ON` with every child FK in the
-- schema pointing at it mid-flight. A join table arrives fully constrained on day one.
--
-- TENANCY IS STRUCTURAL. `workspace_id` arrives in a REQUEST BODY, so a plain
-- `REFERENCES workspaces(id)` would accept (account 2, workspace 10) where workspace 10 belongs to
-- account 1 — both halves individually valid. The FK is COMPOSITE and NAMED, so Postgres quotes the
-- name in the violation message and a grep for it finds a live constraint.
CREATE TABLE IF NOT EXISTS `workspace_repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_repos_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_repos_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_repos_account_repo` ON `workspace_repos` (`account_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_repos_account_workspace_idx` ON `workspace_repos` (`account_id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_repos_repo_idx` ON `workspace_repos` (`repo_id`);--> statement-breakpoint

-- 3. THE TIE-BREAK: a repo in 2+ teams keeps its EARLIEST assignment (lowest team_repos.id).
--    Written as a correlated MIN() rather than DISTINCT ON, which SQLite does not have and which
--    would therefore make the two dialects' files structurally different for no reason. The
--    account predicate in the subquery is redundant (repos.id is a global PK, so repo_id already
--    implies the account) and is spelled anyway so tenancy is visible in the statement.
INSERT INTO `workspace_repos` (`account_id`, `workspace_id`, `repo_id`, `created_at`)
SELECT tr.`account_id`, tr.`team_id`, tr.`repo_id`, tr.`created_at`
  FROM `team_repos` tr
 WHERE tr.`id` = (
         SELECT MIN(tr2.`id`) FROM `team_repos` tr2
          WHERE tr2.`repo_id` = tr.`repo_id` AND tr2.`account_id` = tr.`account_id`)
ON CONFLICT (`account_id`, `repo_id`) DO NOTHING;--> statement-breakpoint

-- 4. Every repo with no resulting row → that account's Default. Covers repos that were in no team
--    at all AND (on a replay) anything step 3 could not place. A repo with NO membership row is
--    invisible to every workspace-scoped read, which is why this statement exists and why the
--    runtime keeps a repair (`ensureRepoMemberships`) on the same rule.
INSERT INTO `workspace_repos` (`account_id`, `workspace_id`, `repo_id`, `created_at`)
SELECT r.`account_id`, w.`id`, r.`id`, unixepoch()
  FROM `repos` r
  JOIN `workspaces` w ON w.`account_id` = r.`account_id` AND w.`is_default` = 1
 WHERE NOT EXISTS (SELECT 1 FROM `workspace_repos` wr WHERE wr.`repo_id` = r.`id`)
ON CONFLICT (`account_id`, `repo_id`) DO NOTHING;--> statement-breakpoint

-- 5. Child first (team_repos FKs teams), then the parent. Leaving either behind would leave a
--    second, differently-keyed answer to "which repos are grouped together" in every database —
--    the exact failure `bot_review_classification` was dropped to avoid.
DROP TABLE IF EXISTS `team_repos`;--> statement-breakpoint
DROP TABLE IF EXISTS `teams`;
