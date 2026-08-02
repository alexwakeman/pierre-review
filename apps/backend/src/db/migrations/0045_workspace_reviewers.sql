-- THE BOT OBJECT COLLAPSES ONTO THE WORKSPACE KEY. SQLite / local mode; Postgres twin:
-- migrations-pg/0032_workspace_reviewers.sql. Second half of the change 0044 starts:
--
--   0044  RE-HOME   repo grouping:  teams (m2m)  →  workspaces (1:N), + a Default per account
--   0045  COLLAPSE  the bot object: repo_reviewers + account_reviewers → workspace_reviewers
--
-- `repo_reviewers` answered "is this login a bot" once per (account, repo). `account_reviewers`
-- answered "who is it and what does it cost" once per (account, actor). With one workspace as the
-- only scope, both questions have the same key, so both tables become one row per
-- (account, workspace, actor) — and the fold that reads six repo rows into one metric answer
-- disappears with them.
--
-- ⚠ WHAT MUST NOT BE LOST WITH THE MERGE: the two PROVENANCE FLAGS stay separate columns and are
-- honoured INDEPENDENTLY. `source` owns automated/role/confidence/reasons; `identity_source` owns
-- kind/label. Inside one row that separation is code discipline (a narrowed `set:` object) rather
-- than a table boundary — a classification pass that respects only one of them either reverts a
-- human's vendor correction or freezes auto-detection.
--
-- ⚠ `monthly_cents` IS NEVER IN ANY DERIVED UPDATE. It is the one column no classifier can
-- regenerate. From here on the price is a per-WORKSPACE fact like every other attribute on this
-- row: `setReviewerCost` writes ONE row, nothing fans out, nothing seeds a later row.
-- NULL = no price set, 0 = "recorded as free". Nothing inherits; there is no chain behind a `??`.
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
--                calls the actor automated — so a manual "this is a human" on repo B losing to an
--                auto-automated repo A is faithful. But `source` is not only a read input: it is
--                the WRITE GATE in persist() and the flag behind the "Reset classification"
--                affordance. Folding it to 'auto' would let the next classification pass silently
--                overwrite a human's opinion, with no control offered to undo it and no trace in
--                reasons_json. A visible, resettable pin the user can see is strictly better than
--                a judgement that vanishes. (Same for a manual role='quality_check' that loses to
--                an auto 'review': the role is wrong AND pinned — so the fold FLAGS it, below.)
--                ELSE the source of the winning evidence — carried, not invented: the highest
--                confidence row on the winning side of `automated`, ties broken by updated_at DESC
--                then repo_id ASC so both dialects pick the same row. ⚠ NEVER the literal 'auto':
--                that is the `identity_source` vocabulary. `ClassificationSource` is
--                'manual'|'vendor_login'|'github_type'|'app_attribution'|'fingerprint'|
--                'behavioral'|'ai_tiebreak' and an out-of-union value would never self-heal —
--                persist() only revisits rows it derives, and the listing's lazy trigger is a
--                MISSING row, which after this migration no actor has. `'fingerprint'` is the
--                fallback if the subquery somehow finds nothing (it matches persistHumanJudgement's
--                choice for a derived, fully re-derivable row).
--
--   reasons_json = SYNTHESISED, not carried. One repo row's reason text does not describe a
--                workspace verdict, the field is advisory display evidence, and the next
--                classification pass overwrites it for every non-manual row. Carrying it would
--                need a per-dialect "pick one row" statement (sqlite bare-columns vs pg
--                DISTINCT ON) for text nobody reads twice. ⚠ A fold where a manual row LOST gets
--                an explicit conflict string ("⚠ conflicting per-repo judgements were merged —
--                review this"), so the one case where a human's judgement was superseded is
--                visible on the card rather than inferred from a mismatched provenance flag.
--
--   kind, label, identity_source = copied from the actor's account_reviewers row. Account-grain
--                today, so they REPLICATE into each workspace the actor appears in. That
--                replication is the accepted consequence of the merge: from here on they are
--                per-workspace facts and may legitimately diverge.
--   monthly_cents = copied into every workspace row of that actor, on exactly the same footing.
--                This is the faithful carry-over of a value that WAS account-wide — a ONE-TIME
--                SEED, not an invariant. From here on price is a per-workspace fact like kind and
--                label: `setReviewerCost` writes ONE row, nothing fans out, nothing seeds a later
--                row, and the copies diverge freely as the user edits them.
--
-- Actors with an account_reviewers row but NO repo_reviewers row anywhere are DROPPED — the
-- listing has always been row-driven, and such an identity could never be displayed, edited or
-- cleared (the same rule the 404 on the old identity route enforced).
--
-- ── ON RE-RUNNING THIS FILE ─────────────────────────────────────────────────────────────────
-- The legacy sources are STUBBED, exactly as 0044 stubs `teams`, so the backfill is a legal empty
-- statement on a database where they have already gone. `repo_reviewers` and `account_reviewers`
-- are DROPPED at the bottom: leaving either would leave a second, differently-keyed answer to the
-- same question sitting in every database.

CREATE TABLE IF NOT EXISTS `repo_reviewers` (
	`account_id` integer, `repo_id` integer, `author_user_id` integer, `automated` integer,
	`role` text, `confidence` text, `source` text, `reasons_json` text, `updated_at` integer
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `account_reviewers` (
	`account_id` integer, `author_user_id` integer, `kind` text, `label` text,
	`identity_source` text, `monthly_cents` integer
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `workspace_reviewers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`author_user_id` integer NOT NULL,
	`automated` integer NOT NULL,
	`role` text DEFAULT 'review' NOT NULL,
	`confidence` text NOT NULL,
	`source` text NOT NULL,
	`reasons_json` text,
	`kind` text,
	`label` text,
	`identity_source` text DEFAULT 'auto' NOT NULL,
	`monthly_cents` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_reviewers_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_reviewers_account_workspace_author` ON `workspace_reviewers` (`account_id`,`workspace_id`,`author_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_reviewers_account_workspace_idx` ON `workspace_reviewers` (`account_id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_reviewers_account_author_idx` ON `workspace_reviewers` (`account_id`,`author_user_id`);--> statement-breakpoint

INSERT INTO `workspace_reviewers`
  (`account_id`, `workspace_id`, `author_user_id`, `automated`, `role`, `confidence`, `source`,
   `reasons_json`, `kind`, `label`, `identity_source`, `monthly_cents`, `updated_at`)
SELECT f.`account_id`, f.`workspace_id`, f.`author_user_id`,
       f.`aut`,
       CASE WHEN f.`any_review` = 1 THEN 'review' ELSE 'quality_check' END,
       CASE WHEN f.`aut` = 1 THEN
              CASE f.`conf_aut` WHEN 3 THEN 'high' WHEN 2 THEN 'medium' ELSE 'low' END
            ELSE
              CASE f.`conf_any` WHEN 3 THEN 'high' WHEN 2 THEN 'medium' ELSE 'low' END
       END,
       -- source: 'manual' if ANY contributing row was manual (the pin survives, visibly);
       -- otherwise the winning row's OWN source — a real ClassificationSource member, never 'auto'.
       CASE WHEN f.`manual_any` = 1 THEN 'manual' ELSE COALESCE((
              SELECT rr2.`source`
                FROM `repo_reviewers` rr2
                JOIN `workspace_repos` wr2
                  ON wr2.`repo_id` = rr2.`repo_id` AND wr2.`account_id` = rr2.`account_id`
               WHERE rr2.`account_id`     = f.`account_id`
                 AND wr2.`workspace_id`   = f.`workspace_id`
                 AND rr2.`author_user_id` = f.`author_user_id`
                 AND rr2.`automated`      = f.`aut`
               ORDER BY CASE rr2.`confidence` WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                        rr2.`updated_at` DESC, rr2.`repo_id` ASC
               LIMIT 1), 'fingerprint') END,
       CASE WHEN f.`aut` = 1 AND f.`manual_aut` = 1
              THEN '["manually tagged as an automated reviewer"]'
            WHEN f.`aut` = 0 AND f.`manual_any` = 1
              THEN '["manually confirmed as a human"]'
            -- The one lossy case, named out loud on the card rather than left to be inferred.
            WHEN f.`manual_any` = 1
              THEN '["migrated from the per-repo classification","⚠ conflicting per-repo judgements were merged — review this"]'
            ELSE '["migrated from the per-repo classification"]' END,
       ar.`kind`, ar.`label`, COALESCE(ar.`identity_source`, 'auto'), ar.`monthly_cents`,
       f.`upd`
  FROM (
    SELECT rr.`account_id`                                                    AS `account_id`,
           wr.`workspace_id`                                                  AS `workspace_id`,
           rr.`author_user_id`                                                AS `author_user_id`,
           MAX(rr.`automated`)                                                AS `aut`,
           -- COALESCE: the live column is NOT NULL DEFAULT 'review', but the legacy-source STUB
           -- above declares `role text` NULLABLE, and SQL three-valued logic sends a NULL role to
           -- ELSE 0 — i.e. every reviewer folds to 'quality_check' on a stub replay.
           MAX(CASE WHEN COALESCE(rr.`role`,'review') <> 'quality_check' THEN 1 ELSE 0 END) AS `any_review`,
           MAX(CASE WHEN rr.`automated` = 1
                    THEN CASE rr.`confidence` WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END
                    ELSE 0 END)                                               AS `conf_aut`,
           MAX(CASE rr.`confidence` WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS `conf_any`,
           MAX(CASE WHEN rr.`source` = 'manual' AND rr.`automated` = 1 THEN 1 ELSE 0 END) AS `manual_aut`,
           MAX(CASE WHEN rr.`source` = 'manual' THEN 1 ELSE 0 END)            AS `manual_any`,
           MAX(rr.`updated_at`)                                              AS `upd`
      FROM `repo_reviewers` rr
      JOIN `workspace_repos` wr
        ON wr.`repo_id` = rr.`repo_id` AND wr.`account_id` = rr.`account_id`
     GROUP BY rr.`account_id`, wr.`workspace_id`, rr.`author_user_id`
  ) f
  LEFT JOIN `account_reviewers` ar
    ON ar.`account_id` = f.`account_id` AND ar.`author_user_id` = f.`author_user_id`
 WHERE true
ON CONFLICT (`account_id`, `workspace_id`, `author_user_id`) DO NOTHING;--> statement-breakpoint

DROP TABLE IF EXISTS `repo_reviewers`;--> statement-breakpoint
DROP TABLE IF EXISTS `account_reviewers`;
