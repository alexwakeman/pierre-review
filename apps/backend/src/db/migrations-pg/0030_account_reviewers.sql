-- NORMALISE THE ACTOR GRAIN OUT OF `repo_reviewers` — the Postgres twin of the sqlite migration
-- 0043_account_reviewers. Hand-written additive, idempotent. Second half of the change 0029
-- starts:
--
--   0029  RE-KEY     (account, author)        →  (account, repo, author)     columns unchanged
--   0030  NORMALISE  the actor-grain columns  →  their own table `account_reviewers`
--
-- WHY. After 0029, `kind` / `label` / `identity_source` sit REPLICATED on every one of an actor's
-- repo rows, held consistent only by convention — the same hazard that giving cost its own
-- storage was meant to eliminate, left in place for three other columns. It carried three
-- standing obligations: a new repo row had to SEED all three from its siblings; persist() had to
-- gate on TWO provenance flags in one row; and the account-wide identity was "a straight read of
-- any one of them", which elects a winner the moment two rows disagree. One row per actor deletes
-- all three. Full argument in the sqlite twin.
--
-- COST IS FOLDED IN rather than given a third table: a price is just another actor-level
-- property, and a separate table on the same key would be this one with extra steps. One table
-- per grain.
--
-- `monthly_cents` IS THEREFORE NULLABLE, where a standalone cost table had it NOT NULL ("no
-- price" was "no row"). A row that also carries identity exists for reasons unrelated to money.
-- That is SAFE here in a way it was not before: the old bug class was nullable-means-INHERIT,
-- with a fallback chain behind it, where 0 ("free HERE") and NULL ("ask my parent") had to be
-- told apart with `??` rather than `||`. NOTHING INHERITS ANY MORE — NULL is "no price set", 0 is
-- "free", two states and no chain. Clearing a price is `SET monthly_cents = NULL`, not a DELETE.
--
-- `account_reviewers` is named for its KEY, exactly as `repo_reviewers` is, so the two names ARE
-- the statement of the model. Not `reviewer_identities` (which would make `monthly_cents` look
-- like a stray) and not `reviewer_costs` (which made `kind`/`label` look the same way).
--
-- ⚠ DRAFT-STATE HOUSEKEEPING — DELETE BEFORE THIS BRANCH MERGES. `reviewer_costs` was created by
-- an earlier draft of this migration while the branch was unpushed and never existed in any
-- released version. The guarded carry-over below exists ONLY so a machine that ran that draft
-- keeps the prices it typed; everywhere else `to_regclass` is NULL and it does nothing. No
-- Postgres deployment has ever run the draft — this is here for symmetry with the sqlite twin,
-- which needs it, and both go at the same time.
CREATE TABLE IF NOT EXISTS "account_reviewers" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"author_user_id" integer NOT NULL REFERENCES "users"("id"),
	"kind" text,
	"label" text,
	"identity_source" text DEFAULT 'auto' NOT NULL,
	"monthly_cents" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_reviewers_account_author" ON "account_reviewers" USING btree ("account_id","author_user_id");--> statement-breakpoint
-- ONE ROW PER ACTOR, LIFTED OFF WHICHEVER REPO ROW IS MOST AUTHORITATIVE. After 0029 an actor's
-- rows agree by construction, so any of them would do; the tie-break is stated because this is
-- exactly the "elect a winner" step the new shape abolishes, and doing it ONCE, here, with a
-- written rule is the honest way to abolish it: prefer a MANUAL identity, then the most recently
-- updated row. DISTINCT ON + ORDER BY is the same selection the sqlite twin spells with SQLite's
-- bare-columns-follow-the-max() rule.
INSERT INTO "account_reviewers"
  ("account_id", "author_user_id", "kind", "label", "identity_source", "updated_at")
SELECT DISTINCT ON ("account_id", "author_user_id")
       "account_id", "author_user_id", "kind", "label", "identity_source", "updated_at"
  FROM "repo_reviewers"
 ORDER BY "account_id", "author_user_id", ("identity_source" = 'manual') DESC, "updated_at" DESC
ON CONFLICT ("account_id", "author_user_id") DO NOTHING;--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.reviewer_costs') IS NOT NULL THEN
    UPDATE "account_reviewers" ar
       SET "monthly_cents" = rc."monthly_cents"
      FROM "reviewer_costs" rc
     WHERE rc."account_id"     = ar."account_id"
       AND rc."author_user_id" = ar."author_user_id";
  END IF;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "reviewer_costs";--> statement-breakpoint
-- The point of the whole file: after this, a repo row can say nothing about WHO the actor is.
-- `RepoReviewer` on the wire exposes no identity field and `ReviewerIdentity` exposes no
-- judgement field, and now the storage says the same thing.
ALTER TABLE "repo_reviewers" DROP COLUMN IF EXISTS "kind";--> statement-breakpoint
ALTER TABLE "repo_reviewers" DROP COLUMN IF EXISTS "label";--> statement-breakpoint
ALTER TABLE "repo_reviewers" DROP COLUMN IF EXISTS "identity_source";
