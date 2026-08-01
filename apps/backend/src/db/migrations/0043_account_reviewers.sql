-- NORMALISE THE ACTOR GRAIN OUT OF `repo_reviewers`. SQLite / local mode; Postgres twin:
-- migrations-pg/0030_account_reviewers.sql. Second half of the change 0042 starts:
--
--   0042  RE-KEY     (account, author)        →  (account, repo, author)     columns unchanged
--   0043  NORMALISE  the actor-grain columns  →  their own table `account_reviewers`
--
-- ── WHAT WAS WRONG WITH LEAVING THEM ON THE REPO ROW ────────────────────────────────────────
-- After 0042, `kind`, `label` and `identity_source` sit on every one of an actor's repo rows,
-- REPLICATED, held consistent by convention with no constraint anywhere. That is precisely the
-- hazard that giving cost its own storage was meant to eliminate — left in place for three other
-- columns — and it was the source of three standing obligations on code that has not been written
-- yet:
--   1. creating a NEW repo row for an actor had to SEED all three from its siblings, or the
--      newest repo rendered the vendor differently from the rest;
--   2. persist() had to gate on TWO different provenance flags sitting side by side in one row
--      (`identity_source` for kind/label, `source` for automated/role), and confusing them
--      reverts a human's vendor correction or freezes auto-detection account-wide;
--   3. the account-wide identity the wire serves was documented as "a straight read of any one of
--      them" — which silently ELECTS A WINNER the moment two rows disagree, and no tie-break can
--      make the losing rows editable or even visible.
-- One row per actor deletes all three. There is no seeding (nothing to seed from), no second
-- provenance flag in the same row (they are on different tables now), and no election (there is
-- one row).
--
-- ── COST IS FOLDED IN, NOT GIVEN A THIRD TABLE ──────────────────────────────────────────────
-- A price is just another actor-level property. A separate `reviewer_costs` keyed on the same two
-- columns would be joined at every call site — this table with extra steps. ONE TABLE PER GRAIN
-- is the clearest possible statement of the model, and it is the same argument that moves
-- kind/label here.
--
-- `monthly_cents` IS THEREFORE NULLABLE, where a standalone cost table had it NOT NULL. That was
-- the point there: "no price" was "no row", so clearing a price was a DELETE and there was no
-- third state. A row that also carries identity exists for reasons that have nothing to do with
-- money, so the column must be nullable.
--
-- DO NOT REINTRODUCE THE OLD FEAR. The bug class that made nullable money dangerous was
-- nullable-means-INHERIT: NULL meant "fall through to the team-0 row", so 0 ("free HERE") and
-- NULL ("ask my parent") had to be told apart with `??` and never `||` — one character from a
-- silently wrong price. THERE IS NO INHERITANCE ANYWHERE ANY MORE. NULL means "no price set" and
-- 0 means "free": two states, no chain, no fallback, nothing to resolve. Clearing a price is
-- `SET monthly_cents = NULL`, not a DELETE — deleting the row would take the identity with it.
--
-- ── WHY `account_reviewers` ─────────────────────────────────────────────────────────────────
-- Named for its KEY, exactly as `repo_reviewers` is, so the two table names ARE the statement of
-- the model: one row per (account, author) here, one per (account, repo, author) there. It is
-- deliberately not named after any single fact it holds — `reviewer_identities` would make
-- `monthly_cents` look like a stray column, and `reviewer_costs` made `kind`/`label` look the
-- same way. The table is defined by its grain, so the next actor-level fact (a plan tier, a
-- contract end date) lands here without renaming anything.
--
-- ── REPLAY ──────────────────────────────────────────────────────────────────────────────────
-- Everything down to the DROP is IF NOT EXISTS / ON CONFLICT DO NOTHING. The three DROP COLUMNs
-- are NOT re-runnable: SQLite has no `DROP COLUMN IF EXISTS` (the pg twin uses one). drizzle's
-- journal never re-runs an applied migration, so that is a hand-replay limitation only, and it is
-- stated rather than hidden.
--
-- ⚠ WHAT THE COMMITTED DRAFT'S OWN COLUMNS DO *NOT* CARRY, and why the omission is deliberate.
-- The superseded 0042/0043 on this branch added `team_id`, `role` and `cost_monthly_cents` to
-- `bot_review_classification`. A database at the 0041 state — every fresh clone, CI, and every
-- peer — has NONE of those columns, and a single .sql file cannot reference a column that may or
-- may not exist (SQLite has no conditional DDL and would fail to PARSE the statement, not skip
-- it). So 0042 reads only the pre-draft column set and writes `role` as its default.
-- Consequence, scoped honestly: on a machine that ran the superseded draft, a per-team `role`
-- override and a price typed INLINE are not carried. Prices that came from the legacy
-- `pro_settings.bot_cost_json` blob are unaffected — pro 0019 re-imports them, and the blob is
-- never dropped. That leaves only values typed into the one-day-old inline editor, on unpushed
-- dev machines, which is a set of two on the author's box and empty everywhere else; both were
-- preserved by hand. Contorting this file for a state that exists on one machine and can never
-- occur again would make it wrong for every machine that matters.
--
-- ⚠ DRAFT-STATE HOUSEKEEPING — DELETE BEFORE THIS BRANCH MERGES. `reviewer_costs` was created by
-- an earlier draft of 0043 while this branch was unpushed and never existed in any released
-- version. The stub + carry-over + drop below exist ONLY so a machine that ran that draft keeps
-- the prices it typed. On every other database the stub is created empty, carries nothing, and is
-- dropped again. Once no such machine is left, delete these three statements.
CREATE TABLE IF NOT EXISTS `reviewer_costs` (
	`account_id` integer,
	`author_user_id` integer,
	`monthly_cents` integer
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `account_reviewers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`author_user_id` integer NOT NULL,
	`kind` text,
	`label` text,
	`identity_source` text DEFAULT 'auto' NOT NULL,
	`monthly_cents` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `account_reviewers_account_author` ON `account_reviewers` (`account_id`,`author_user_id`);--> statement-breakpoint
-- ONE ROW PER ACTOR, LIFTED OFF WHICHEVER REPO ROW IS MOST AUTHORITATIVE. After 0042 an actor's
-- rows agree by construction, so on a freshly migrated database any of them would do; the
-- tie-break exists because this is exactly the "elect a winner" step the new shape abolishes, and
-- doing it ONCE, here, with a stated rule is the honest way to abolish it: prefer a MANUAL
-- identity (a human named this thing), then the most recently updated row.
--
-- The `max(...)` in the subquery is not decoration. SQLite's documented bare-columns rule — when
-- a query has exactly one min()/max() aggregate, the other bare columns are taken FROM THE ROW
-- THAT MATCHED — is what makes kind/label/identity_source/updated_at come from one single row
-- rather than four independent aggregates. The pg twin spells the same rule as DISTINCT ON with
-- an ORDER BY; different syntax, identical selection.
INSERT INTO `account_reviewers`
  (`account_id`, `author_user_id`, `kind`, `label`, `identity_source`, `updated_at`)
SELECT `account_id`, `author_user_id`, `kind`, `label`, `identity_source`, `updated_at`
  FROM (
    SELECT `account_id`, `author_user_id`, `kind`, `label`, `identity_source`, `updated_at`,
           max((`identity_source` = 'manual') * 100000000000 + `updated_at`) AS pick
      FROM `repo_reviewers`
     GROUP BY `account_id`, `author_user_id`
  )
 WHERE true
ON CONFLICT (`account_id`, `author_user_id`) DO NOTHING;--> statement-breakpoint
UPDATE `account_reviewers`
   SET `monthly_cents` = (
         SELECT rc.`monthly_cents` FROM `reviewer_costs` rc
          WHERE rc.`account_id`     = `account_reviewers`.`account_id`
            AND rc.`author_user_id` = `account_reviewers`.`author_user_id`)
 WHERE EXISTS (
         SELECT 1 FROM `reviewer_costs` rc
          WHERE rc.`account_id`     = `account_reviewers`.`account_id`
            AND rc.`author_user_id` = `account_reviewers`.`author_user_id`);--> statement-breakpoint
DROP TABLE IF EXISTS `reviewer_costs`;--> statement-breakpoint
-- The point of the whole file: after this, a repo row can say nothing about WHO the actor is.
-- `RepoReviewer` on the wire exposes no identity field and `ReviewerIdentity` exposes no
-- judgement field, and now the storage says the same thing.
ALTER TABLE `repo_reviewers` DROP COLUMN `kind`;--> statement-breakpoint
ALTER TABLE `repo_reviewers` DROP COLUMN `label`;--> statement-breakpoint
ALTER TABLE `repo_reviewers` DROP COLUMN `identity_source`;
