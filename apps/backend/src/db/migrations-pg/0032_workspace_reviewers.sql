-- THE BOT OBJECT COLLAPSES ONTO THE WORKSPACE KEY. Postgres / cloud mode; the SQLite twin is
-- migrations/0045_workspace_reviewers.sql. Second half of the change 0031 starts.
--
-- `repo_reviewers` answered "is this login a bot" once per (account, repo). `account_reviewers`
-- answered "who is it and what does it cost" once per (account, actor). With one workspace as the
-- only scope, both questions have the same key, so both tables become one row per
-- (account, workspace, actor) — and the fold that reads six repo rows into one metric answer
-- disappears with them.
--
-- ⚠ WHAT MUST NOT BE LOST WITH THE MERGE: the two PROVENANCE FLAGS stay separate columns and are
-- honoured INDEPENDENTLY. `source` owns automated/role/confidence/reasons; `identity_source` owns
-- kind/label. `monthly_cents` is owned by nothing derived — exactly one writer (setReviewerCost)
-- names exactly one row, and the column appears in no other `set:` object anywhere. NULL = no
-- price set, 0 = "recorded as free"; nothing inherits, so there is no chain behind a `??`.
--
-- ── THE FOLD RULE ────────────────────────────────────────────────────────────────────────────
-- For each (account, workspace, actor) with at least one repo_reviewers row on a repo now in
-- that workspace:
--   automated  = TRUE if ANY contributing row is automated              (union — this half DOES
--   role       = 'review' if ANY contributing row roles it 'review'      reproduce resolveJudgements
--                else 'quality_check'                                    exactly, for READS)
--   confidence = the highest confidence among the rows that carried the WINNING `automated` value
--                (folding the max across all rows lets an automated=false row hand `high` to an
--                 automated=true verdict it disagreed with)
--   updated_at = MAX of the contributing rows
--
--   source     = 'manual' if ANY contributing row is manual, regardless of which side won.
--                ⚠ THIS IS DELIBERATELY *NOT* THE READ-TIME UNION RULE, and the difference is the
--                whole point. For reads, `manualHuman` is only consulted when nothing in scope
--                calls the actor automated. But `source` is not only a read input: it is the WRITE
--                GATE in persist() and the flag behind the "Reset classification" affordance.
--                Folding it to 'auto' would let the next classification pass silently overwrite a
--                human's opinion, with no control offered to undo it and no trace in reasons_json.
--                A visible, resettable pin the user can see is strictly better than a judgement
--                that vanishes. ELSE the source of the winning evidence — carried, not invented:
--                the highest confidence row on the winning side of `automated`, ties broken by
--                updated_at DESC then repo_id ASC so both dialects pick the same row. ⚠ NEVER the
--                literal 'auto': that is the `identity_source` vocabulary. `ClassificationSource`
--                is 'manual'|'vendor_login'|'github_type'|'app_attribution'|'fingerprint'|
--                'behavioral'|'ai_tiebreak' and an out-of-union value would never self-heal.
--                'fingerprint' is the fallback if the subquery somehow finds nothing.
--
--   reasons_json = SYNTHESISED, not carried. One repo row's reason text does not describe a
--                workspace verdict, the field is advisory display evidence, and the next
--                classification pass overwrites it for every non-manual row. ⚠ A fold where a
--                manual row LOST gets an explicit conflict string, so the one case where a human's
--                judgement was superseded is visible on the card rather than inferred from a
--                mismatched provenance flag.
--
--   kind, label, identity_source = copied from the actor's account_reviewers row. Account-grain
--                today, so they REPLICATE into each workspace the actor appears in. That
--                replication is the accepted D5 consequence: from here on they are per-workspace
--                facts and may legitimately diverge.
--   monthly_cents = copied into every workspace row of that actor, on exactly the same footing.
--                This is the faithful carry-over of a value that WAS account-wide — a ONE-TIME
--                SEED, not an invariant. From here on price is a per-workspace fact like kind and
--                label: setReviewerCost writes ONE row, nothing fans out, nothing seeds a later
--                row, and the copies diverge freely as the user edits them.
--
-- Actors with an account_reviewers row but NO repo_reviewers row anywhere are DROPPED — the
-- listing has always been row-driven, and such an identity could never be displayed, edited or
-- cleared (the same rule the 404 on the old identity route enforced).
--
-- ⚠ DIALECT DIVERGENCES THAT MAY NOT BE "UNIFIED" (the sqlite twin is the reference for each):
--   • `bool_or(rr.automated)` — pg has no `max(boolean)`; `MAX()` would fail to plan.
--   • bare booleans (`rr.automated`, `f.aut`) where sqlite writes `= 1`.
--   • BUT `manual_aut` / `manual_any` / `any_review` are INTEGER `MAX(CASE … 1 ELSE 0 END)` in
--     BOTH dialects, so they must still be compared with `= 1` here. `CASE WHEN f.aut AND
--     f.manual_aut THEN …` is a HARD TYPE ERROR — Postgres has no implicit integer→boolean cast
--     and raises `argument of AND must be type boolean, not type integer`, aborting the whole
--     migration. (`rr2.automated = f.aut` is boolean = boolean here and integer = integer in
--     sqlite, so that one line is genuinely identical in both files.)
--   • `::jsonb` on the synthesised reasons — the pg column is jsonb, not text.
--   • the backfill is wrapped in a `to_regclass` guard rather than preceded by legacy-table stubs:
--     this file drops the tables its own backfill reads, and pg has conditional DDL while sqlite
--     does not. Same intent, two dialects, stated rather than discovered.
--   • no `WHERE true` before `ON CONFLICT` — that disambiguator is a sqlite parsing quirk only.
CREATE TABLE IF NOT EXISTS "workspace_reviewers" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	-- No cascade: `users` is GLOBAL storage shared by every account and is never deleted.
	"author_user_id" integer NOT NULL REFERENCES "users"("id"),
	"automated" boolean NOT NULL,
	"role" text DEFAULT 'review' NOT NULL,
	"confidence" text NOT NULL,
	"source" text NOT NULL,
	"reasons_json" jsonb,
	"kind" text,
	"label" text,
	"identity_source" text DEFAULT 'auto' NOT NULL,
	"monthly_cents" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_reviewers_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);--> statement-breakpoint
-- The upsert conflict target for EVERY writer. A stale target type-checks perfectly and raises
-- "no unique or exclusion constraint matching the ON CONFLICT specification" at RUNTIME, in both
-- dialects, only when a row is actually written.
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_reviewers_account_workspace_author" ON "workspace_reviewers" USING btree ("account_id","workspace_id","author_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_reviewers_account_workspace_idx" ON "workspace_reviewers" USING btree ("account_id","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_reviewers_account_author_idx" ON "workspace_reviewers" USING btree ("account_id","author_user_id");--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.repo_reviewers') IS NOT NULL THEN
    INSERT INTO "workspace_reviewers"
      ("account_id", "workspace_id", "author_user_id", "automated", "role", "confidence", "source",
       "reasons_json", "kind", "label", "identity_source", "monthly_cents", "updated_at")
    SELECT f."account_id", f."workspace_id", f."author_user_id",
           f."aut",
           CASE WHEN f."any_review" = 1 THEN 'review' ELSE 'quality_check' END,
           CASE WHEN f."aut" THEN
                  CASE f."conf_aut" WHEN 3 THEN 'high' WHEN 2 THEN 'medium' ELSE 'low' END
                ELSE
                  CASE f."conf_any" WHEN 3 THEN 'high' WHEN 2 THEN 'medium' ELSE 'low' END
           END,
           -- source: 'manual' if ANY contributing row was manual (the pin survives, visibly);
           -- otherwise the winning row's OWN source — a real ClassificationSource member, never
           -- 'auto'.
           CASE WHEN f."manual_any" = 1 THEN 'manual' ELSE COALESCE((
                  SELECT rr2."source"
                    FROM "repo_reviewers" rr2
                    JOIN "workspace_repos" wr2
                      ON wr2."repo_id" = rr2."repo_id" AND wr2."account_id" = rr2."account_id"
                   WHERE rr2."account_id"     = f."account_id"
                     AND wr2."workspace_id"   = f."workspace_id"
                     AND rr2."author_user_id" = f."author_user_id"
                     AND rr2."automated"      = f."aut"
                   ORDER BY CASE rr2."confidence" WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                            rr2."updated_at" DESC, rr2."repo_id" ASC
                   LIMIT 1), 'fingerprint') END,
           CASE WHEN f."aut" AND f."manual_aut" = 1
                  THEN '["manually tagged as an automated reviewer"]'::jsonb
                WHEN NOT f."aut" AND f."manual_any" = 1
                  THEN '["manually confirmed as a human"]'::jsonb
                -- The one lossy case, named out loud on the card rather than left to be inferred.
                WHEN f."manual_any" = 1
                  THEN '["migrated from the per-repo classification","⚠ conflicting per-repo judgements were merged — review this"]'::jsonb
                ELSE '["migrated from the per-repo classification"]'::jsonb END,
           ar."kind", ar."label", COALESCE(ar."identity_source", 'auto'), ar."monthly_cents",
           f."upd"
      FROM (
        SELECT rr."account_id"                                                AS "account_id",
               wr."workspace_id"                                              AS "workspace_id",
               rr."author_user_id"                                            AS "author_user_id",
               bool_or(rr."automated")                                        AS "aut",
               MAX(CASE WHEN COALESCE(rr."role",'review') <> 'quality_check' THEN 1 ELSE 0 END) AS "any_review",
               MAX(CASE WHEN rr."automated"
                        THEN CASE rr."confidence" WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END
                        ELSE 0 END)                                           AS "conf_aut",
               MAX(CASE rr."confidence" WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS "conf_any",
               MAX(CASE WHEN rr."source" = 'manual' AND rr."automated" THEN 1 ELSE 0 END) AS "manual_aut",
               MAX(CASE WHEN rr."source" = 'manual' THEN 1 ELSE 0 END)        AS "manual_any",
               MAX(rr."updated_at")                                           AS "upd"
          FROM "repo_reviewers" rr
          JOIN "workspace_repos" wr
            ON wr."repo_id" = rr."repo_id" AND wr."account_id" = rr."account_id"
         GROUP BY rr."account_id", wr."workspace_id", rr."author_user_id"
      ) f
      LEFT JOIN "account_reviewers" ar
        ON ar."account_id" = f."account_id" AND ar."author_user_id" = f."author_user_id"
    ON CONFLICT ("account_id", "workspace_id", "author_user_id") DO NOTHING;
  END IF;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "repo_reviewers";--> statement-breakpoint
DROP TABLE IF EXISTS "account_reviewers";
