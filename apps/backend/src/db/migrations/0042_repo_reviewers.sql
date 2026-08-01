-- THE BOT OBJECT BECOMES PER REPO. SQLite / local mode; Postgres twin:
-- migrations-pg/0029_repo_reviewers.sql. Migration 0043 then splits the ACTOR grain back out of
-- the table this one creates — read the two together, they are one change in two steps:
--
--   0042  RE-KEY     (account, author)        →  (account, repo, author)     columns unchanged
--   0043  NORMALISE  the actor-grain columns  →  their own table `account_reviewers`
--
-- Keeping them separate is deliberate: the re-key is a fan-out with a footprint rule and a
-- careful backfill, the normalisation is a lift of three columns and a price. Fused into one
-- file, a reader cannot tell which statement is doing which job.
--
-- `bot_review_classification` answered "is this login a bot, and what kind" once per ACCOUNT.
-- `repo_reviewers` answers it once per (account, REPO, author), and that row IS the bot object.
--
-- WHY THE REPO IS THE KEY. A bot is installed per repository — GitHub Apps are installed on
-- repos, CI configs live in repos — while a team is a bag of repos someone can re-bag tomorrow.
-- Keying the judgement on a team made the answer move when team membership was edited and forced
-- an inheritance chain (team row → default row → auto-detect) whose null-means-inherit rules
-- leaked into every read. Keying on the repo removes the chain: one row per repo, nothing to fall
-- back to, nothing to merge, and NO DEDUPLICATION anywhere — a vendor on six repos is six rows,
-- which is the intended display.
--
-- IT REPLACES THE OLD TABLE RATHER THAN EXTENDING IT. `bot_review_classification` is DROPPED at
-- the bottom: leaving it would leave a second, differently-keyed answer to the same question
-- sitting in every database, which is exactly how two surfaces come to disagree.
--
-- ── THE BACKFILL, AND WHY IT IS ASYMMETRIC ──────────────────────────────────────────────────
-- MANUAL rows fan out to EVERY repo in the account. A human judgement is the only thing here
-- that cannot be regenerated, it was made account-wide, and fanning it out reproduces that
-- meaning exactly — every repo row agrees, which is the invariant ("only a human edit should ever
-- make two of an actor's rows disagree") stated as data.
--
-- AUTO rows land only on repos where the actor ACTUALLY HAS A FOOTPRINT — submitted a review,
-- opened an inline thread, or left a PR comment there. Two reasons: an auto verdict is cheap and
-- re-derived on the next classification pass, so nothing is lost if this misses; and a row for a
-- repo the reviewer has never touched is not a bot object, it is a fabricated one. On a real
-- account that is the difference between a few hundred rows and actors × repos of noise.
--
-- The footprint CTE is MATERIALIZED on purpose: without it SQLite may re-evaluate the union for
-- every (row, repo) pair, turning a one-off migration into minutes of nested scans.
--
-- The role seed at the bottom is the one judgement this migration adds. Static analysis /
-- coverage / lint (SonarQube, Codecov, Hound) posts review comments and IS automated, but it is
-- not reviewing, and counting it as a reviewer is what makes the Bot-ROI numbers lie. AUTO rows
-- for those logins are re-roled in place so an account that already classified SonarQube (today
-- it resolves to `in_house` via the githubType step — the exact miscount `role` fixes) reads
-- correctly on first load. MANUAL rows are never touched.
--
-- ── TENANCY IS STRUCTURAL HERE, NOT A ROUTE CHECK ───────────────────────────────────────────
-- `repo_id` is the FIRST column in this schema that arrives in a REQUEST BODY rather than from
-- sync (`RepoReviewerJudgementBody.repoId` — the row IS the object, so a judgement names one).
-- A plain `REFERENCES repos(id)` would happily accept (account 2, repo 10) where repo 10 belongs
-- to account 1: both halves are individually valid, and the only thing standing between that and
-- a row written into another tenant's repo would be one hand-written predicate in one handler.
-- So the FK is COMPOSITE — `(repo_id, account_id) REFERENCES repos(id, account_id)` — which the
-- unique index below exists to make legal (SQLite requires a UNIQUE index over the parent key
-- columns; Postgres accepts the same plain unique index, verified on 16.13). The cross-account
-- insert then fails with "FOREIGN KEY constraint failed" in BOTH dialects, in every code path,
-- including a hand-written one. It replaces the single-column repo FK rather than joining it:
-- the composite subsumes it, and two overlapping FKs is two things to keep in step.
--
-- THE CONSTRAINT IS NAMED, and the name is the one `schema.sqlite.ts` declares. SQLite parses and
-- stores a `CONSTRAINT <name> FOREIGN KEY` clause but never reports it (its violation message is
-- the bare "FOREIGN KEY constraint failed" and `PRAGMA foreign_key_list` has no name column), so
-- here it is documentation that at least matches the stored DDL; in Postgres the same name is
-- what the violation message quotes. Previously neither file named it, so drizzle's `name:` field
-- pointed at nothing: pg auto-named the constraint `repo_reviewers_repo_id_account_id_fkey`.
--
-- ── ON RE-RUNNING THIS FILE ─────────────────────────────────────────────────────────────────
-- Every statement is written IF NOT EXISTS / ON CONFLICT DO NOTHING, and the legacy table is
-- stubbed below, so a hand-replay is a no-op rather than a crash. That is the SQLite answer to
-- the pg twin's `to_regclass` guard, which exists for the same reason: this file ends by dropping
-- the table its own backfill reads.
-- The parent key for the composite FK, and nothing else — `repos.id` is already the PK, so this
-- index is redundant for lookups and exists purely so the FK is expressible.
CREATE UNIQUE INDEX IF NOT EXISTS `repos_id_account` ON `repos` (`id`,`account_id`);--> statement-breakpoint
-- Unrelated to the FK, and here because THIS migration is where it starts costing: `review_threads
-- .original_commenter_id` has never had an index, and it is one of the three columns the footprint
-- CTE below unions on (a full scan of `review_threads`) AND the column the per-repo footprint
-- counts (`RepoReviewerFootprint.threads`) group by on every bot listing.
CREATE INDEX IF NOT EXISTS `thread_original_commenter_idx` ON `review_threads` (`original_commenter_id`);--> statement-breakpoint
-- THE LEGACY SOURCE, STUBBED. On every database this migration is meant for, the real table is
-- already there and this is a no-op. It exists so the backfill below is still a legal, empty
-- statement on a database where the table has already gone — a hand-replay of this file, or a
-- machine that ran an earlier draft of it while this branch was unpushed. The stub is dropped at
-- the bottom along with the real thing, so it leaves nothing behind either way.
CREATE TABLE IF NOT EXISTS `bot_review_classification` (
	`account_id` integer,
	`author_user_id` integer,
	`automated` integer,
	`kind` text,
	`label` text,
	`confidence` text,
	`source` text,
	`reasons_json` text,
	`updated_at` integer
);--> statement-breakpoint
-- `kind` / `label` / `identity_source` ARE CREATED HERE AND REMOVED AGAIN IN 0043. This step is a
-- pure re-key: every column of the old row is carried across unchanged so the two migrations can
-- be read (and reasoned about) one at a time. 0043 is where they become one row per actor.
CREATE TABLE IF NOT EXISTS `repo_reviewers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`author_user_id` integer NOT NULL,
	`automated` integer NOT NULL,
	`kind` text,
	`label` text,
	`identity_source` text DEFAULT 'auto' NOT NULL,
	`role` text DEFAULT 'review' NOT NULL,
	`confidence` text NOT NULL,
	`source` text NOT NULL,
	`reasons_json` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `repo_reviewers_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `repo_reviewers_account_repo_author` ON `repo_reviewers` (`account_id`,`repo_id`,`author_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `repo_reviewers_account_repo_idx` ON `repo_reviewers` (`account_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `repo_reviewers_account_author_idx` ON `repo_reviewers` (`account_id`,`author_user_id`);--> statement-breakpoint
WITH footprint AS MATERIALIZED (
  SELECT DISTINCT p.repo_id AS repo_id, x.uid AS author_user_id
    FROM pull_requests p
    JOIN (
      SELECT pr_id, author_id             AS uid FROM reviews         WHERE author_id IS NOT NULL
      UNION ALL
      SELECT pr_id, original_commenter_id AS uid FROM review_threads  WHERE original_commenter_id IS NOT NULL
      UNION ALL
      SELECT pr_id, author_id             AS uid FROM pr_comments     WHERE author_id IS NOT NULL
    ) x ON x.pr_id = p.id
)
INSERT INTO `repo_reviewers`
  (`account_id`, `repo_id`, `author_user_id`, `automated`, `kind`, `label`, `identity_source`,
   `role`, `confidence`, `source`, `reasons_json`, `updated_at`)
-- `identity_source` is derived from the old row's `source` because the old model had only ONE
-- provenance field covering both grains: a manual row's `kind`/`label` WERE a human's opinion,
-- and importing them as 'auto' would let the next classification pass silently revert a vendor
-- correction someone made by hand.
SELECT b.account_id, r.id, b.author_user_id, b.automated, b.kind, b.label,
       CASE WHEN b.source = 'manual' THEN 'manual' ELSE 'auto' END,
       'review', b.confidence, b.source, b.reasons_json, b.updated_at
  FROM bot_review_classification b
  JOIN repos r ON r.account_id = b.account_id
 WHERE (b.source = 'manual'
    OR EXISTS (
         SELECT 1 FROM footprint f
          WHERE f.repo_id = r.id AND f.author_user_id = b.author_user_id
       ))
-- The `WHERE true` disambiguator SQLite needs before ON CONFLICT in an `INSERT … SELECT … FROM`
-- is already satisfied by the real WHERE above (sqlite.org/lang_upsert.html §"Parsing Ambiguity");
-- Postgres has no such ambiguity, which is why the twin's clause reads identically without it.
--
-- ON CONFLICT DO NOTHING never fires on a database this migration is meant for: the legacy table
-- is unique on (account_id, author_user_id), so one row per (account, repo, author) comes out. It
-- is here for the state an unpushed rewrite can leave behind — a machine that ran the deleted
-- team-keyed draft has up to one row per (account, TEAM, author), which collides. The winner is
-- then arbitrary, which is the right answer for a draft artifact and the wrong answer to reach
-- for anywhere else.
ON CONFLICT (`account_id`, `repo_id`, `author_user_id`) DO NOTHING;--> statement-breakpoint
UPDATE `repo_reviewers`
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
  );--> statement-breakpoint
DROP TABLE IF EXISTS `bot_review_classification`;
