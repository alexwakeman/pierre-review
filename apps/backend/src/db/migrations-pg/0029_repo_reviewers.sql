-- THE BOT OBJECT BECOMES PER REPO — the Postgres twin of the sqlite migration
-- 0042_repo_reviewers. Hand-written additive (like 0027/0028), idempotent. Migration 0030 then
-- splits the ACTOR grain back out; read the two together, they are one change in two steps:
--
--   0029  RE-KEY     (account, author)        →  (account, repo, author)     columns unchanged
--   0030  NORMALISE  the actor-grain columns  →  their own table `account_reviewers`
--
-- `bot_review_classification` answered "is this login a bot, and what kind" once per ACCOUNT.
-- `repo_reviewers` answers it once per (account, REPO, author), and that row IS the bot object.
-- A bot is installed per repository; a team is a bag of repos someone can re-bag tomorrow. There
-- is no team key, no inheritance chain, no merge and NO DEDUPLICATION — a vendor running on six
-- repos is six rows, which is the intended display.
--
-- The old table is DROPPED at the bottom rather than left behind: a second, differently-keyed
-- answer to the same question sitting in every database is exactly how two surfaces disagree.
--
-- `kind` / `label` / `identity_source` ARE CREATED HERE AND REMOVED AGAIN IN 0030. This step is a
-- pure re-key — every column of the old row is carried across unchanged — so that the fan-out and
-- the normalisation can be read one at a time.
--
-- TENANCY IS STRUCTURAL. `repo_id` is the first column here that arrives in a REQUEST BODY
-- rather than from sync, and a plain `REFERENCES repos(id)` accepts (account 2, repo 10) where
-- repo 10 belongs to account 1. The FK is therefore COMPOSITE against `repos(id, account_id)`,
-- which the unique index below makes legal — Postgres accepts a plain UNIQUE INDEX as an FK
-- parent key (verified on 16.13; it does not require a named UNIQUE CONSTRAINT), and SQLite
-- requires exactly the same thing, so the twins stay identical. The cross-account insert now
-- fails in the database, in every code path, not in one handler's predicate.
--
-- THE CONSTRAINT IS NAMED, and the name is the one `schema.pg.ts` declares. Postgres quotes it in
-- the violation message ("violates foreign key constraint \"repo_reviewers_repo_account_fk\""),
-- so it is a real, greppable identifier. Previously the SQL named nothing and pg auto-named the
-- constraint `repo_reviewers_repo_id_account_id_fkey`, i.e. drizzle's `name:` field matched no
-- live constraint in any database. (SQLite stores the same clause but never reports it.)
--
-- THE BACKFILL IS ASYMMETRIC ON PURPOSE. MANUAL rows fan out to EVERY repo in the account — a
-- human judgement is the only thing here that cannot be regenerated, it was made account-wide,
-- and fanning it out reproduces that meaning with every repo row agreeing. AUTO rows land only on
-- repos where the actor actually has a FOOTPRINT (a review, an inline thread, or a PR comment
-- there): an auto verdict is re-derived on the next classification pass, and a row for a repo the
-- reviewer has never touched is not a bot object but a fabricated one. See the sqlite twin.
--
-- The footprint CTE is MATERIALIZED so the planner cannot inline it into the correlated EXISTS
-- and re-scan three tables per (row, repo) pair.
--
-- WHY THE BACKFILL IS WRAPPED IN A DO BLOCK: this file ends by dropping
-- `bot_review_classification`, so a hand-replay would otherwise fail on "relation does not exist"
-- rather than no-op. `to_regclass` is the guard; plpgsql does not resolve the branch's SQL until
-- it executes, so naming the dropped table inside it is safe. The sqlite twin reaches the same
-- end with a `CREATE TABLE IF NOT EXISTS` stub of the legacy table, which is the nearest thing
-- that dialect has to a conditional. Same intent, two dialects, stated rather than discovered.
-- Not for lookups (`id` is already the PK) — it exists solely as the composite FK's parent key.
CREATE UNIQUE INDEX IF NOT EXISTS "repos_id_account" ON "repos" USING btree ("id","account_id");--> statement-breakpoint
-- Unrelated to the FK, and the reason it rides in THIS migration: `review_threads
-- .original_commenter_id` had no index at all, and it is one of the three columns the footprint
-- CTE below unions on AND the column the per-repo footprint counts group by on every listing.
CREATE INDEX IF NOT EXISTS "thread_original_commenter_idx" ON "review_threads" USING btree ("original_commenter_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_reviewers" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"repo_id" integer NOT NULL,
	"author_user_id" integer NOT NULL REFERENCES "users"("id"),
	"automated" boolean NOT NULL,
	"kind" text,
	"label" text,
	"identity_source" text DEFAULT 'auto' NOT NULL,
	"role" text DEFAULT 'review' NOT NULL,
	"confidence" text NOT NULL,
	"source" text NOT NULL,
	"reasons_json" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_reviewers_repo_account_fk" FOREIGN KEY ("repo_id","account_id") REFERENCES "repos"("id","account_id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repo_reviewers_account_repo_author" ON "repo_reviewers" USING btree ("account_id","repo_id","author_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_reviewers_account_repo_idx" ON "repo_reviewers" USING btree ("account_id","repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_reviewers_account_author_idx" ON "repo_reviewers" USING btree ("account_id","author_user_id");--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.bot_review_classification') IS NOT NULL THEN
    WITH footprint AS MATERIALIZED (
      SELECT DISTINCT p.repo_id AS repo_id, x.uid AS author_user_id
        FROM pull_requests p
        JOIN (
          SELECT pr_id, author_id             AS uid FROM reviews        WHERE author_id IS NOT NULL
          UNION ALL
          SELECT pr_id, original_commenter_id AS uid FROM review_threads WHERE original_commenter_id IS NOT NULL
          UNION ALL
          SELECT pr_id, author_id             AS uid FROM pr_comments    WHERE author_id IS NOT NULL
        ) x ON x.pr_id = p.id
    )
    INSERT INTO "repo_reviewers"
      ("account_id", "repo_id", "author_user_id", "automated", "kind", "label",
       "identity_source", "role", "confidence", "source", "reasons_json", "updated_at")
    -- `identity_source` is derived from the old row's `source`: the old model had ONE provenance
    -- field covering both grains, and a manual row's kind/label WERE a human's opinion. Import
    -- them as 'auto' and the next classification pass silently reverts a hand-made correction.
    SELECT b.account_id, r.id, b.author_user_id, b.automated, b.kind, b.label,
           CASE WHEN b.source = 'manual' THEN 'manual' ELSE 'auto' END,
           'review', b.confidence, b.source, b.reasons_json, b.updated_at
      FROM bot_review_classification b
      JOIN repos r ON r.account_id = b.account_id
     WHERE b.source = 'manual'
        OR EXISTS (
             SELECT 1 FROM footprint f
              WHERE f.repo_id = r.id AND f.author_user_id = b.author_user_id
           )
    -- Never fires on a database this migration is meant for (the legacy table is unique on
    -- (account_id, author_user_id)). It covers the state an unpushed rewrite can leave behind: a
    -- machine that ran the deleted team-keyed draft has up to one row per (account, TEAM, author).
    ON CONFLICT ("account_id", "repo_id", "author_user_id") DO NOTHING;
  END IF;
END $$;--> statement-breakpoint
UPDATE "repo_reviewers"
SET "role" = 'quality_check'
WHERE "source" <> 'manual'
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE lower("github_login") IN (
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
DROP TABLE IF EXISTS "bot_review_classification";
