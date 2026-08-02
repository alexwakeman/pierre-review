-- TEAMS BECOME WORKSPACES, AND A REPO GETS EXACTLY ONE. Postgres / cloud mode; the SQLite twin is
-- migrations/0044_workspaces.sql. Migration 0032 then collapses the two bot tables onto the
-- workspace key — read them together, they are one change in two steps:
--
--   0031  RE-HOME   repo grouping:  teams (m2m)  →  workspaces (1:N), + a Default per account
--   0032  COLLAPSE  the bot object: repo_reviewers + account_reviewers → workspace_reviewers
--
-- WORKSPACE IDS ARE THE OLD TEAM IDS. Preserved deliberately: a URL, a bookmark, a persisted
-- filter and (after the plugin's own 0020) a cache row all carry the number, and renumbering
-- would silently repoint them at a different repo set.
--
-- ⚠ THE ONE THING THAT DIFFERS BETWEEN THE DIALECTS IS THE SEQUENCE. SQLite AUTOINCREMENT tracks
-- max(rowid) ever seen, so an explicit-id INSERT advances it and the Default rows below get fresh
-- ids for free. Postgres `serial` does NOT advance on an explicit-id INSERT, so this file MUST
-- setval() between step 1 and step 2 or the very next workspace collides with a preserved team id.
-- The failure is a LOUD BOOT FAILURE, not a later 500: step 2 takes nextval = 1, collides with
-- preserved team id 1, `duplicate key value violates unique constraint "workspaces_pkey"` aborts
-- the DO block, runMigrations() throws and cloud never boots.
--
-- ⚠ ONLY STEPS 1 AND 3 ARE GUARDED by `to_regclass`, because they are the only statements that
-- READ `teams` / `team_repos` (this file drops both at the bottom, so a replay would otherwise
-- fail on "relation does not exist" rather than no-op — the pg equivalent of the sqlite twin's
-- `CREATE TABLE IF NOT EXISTS` legacy stubs). Steps 2 (a Default per account) and 4 (unassigned
-- repos → Default) are PLAIN, UNGUARDED statements. Wrapping all four — the obvious reading of
-- "same five steps" — would make a Postgres database that no longer has `teams` (a fresh cloud
-- deploy, a replay after the DROP) create NO workspaces and NO memberships at all, while the
-- sqlite twin's stub tables leave steps 2 and 4 always running. The runtime repair
-- (ensureDefaultWorkspace / ensureRepoMemberships) hides it, so the two files would silently
-- implement two different algorithms.
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_account_name" ON "workspaces" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_account_idx" ON "workspaces" USING btree ("account_id");--> statement-breakpoint
-- Not for lookups (`id` is already the PK) — it is the PARENT KEY of the composite FKs on
-- workspace_repos and workspace_reviewers, exactly as `repos_id_account` (0029) is for those
-- tables' repo FKs. Postgres accepts a plain UNIQUE INDEX as an FK parent key; it does not require
-- a named UNIQUE CONSTRAINT. Drop it and both composite FKs become unexpressible.
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_id_account" ON "workspaces" USING btree ("id","account_id");--> statement-breakpoint
-- 1. One workspace per existing team, IDS PRESERVED.
DO $$
BEGIN
  IF to_regclass('public.teams') IS NOT NULL THEN
    INSERT INTO "workspaces" ("id", "account_id", "name", "is_default", "created_at")
    SELECT "id", "account_id", "name", false, "created_at" FROM "teams"
    ON CONFLICT ("id") DO NOTHING;
  END IF;
END $$;--> statement-breakpoint
-- 1b. ADVANCE THE SEQUENCE PAST THE PRESERVED IDS. No sqlite counterpart — do not "harmonise it
--     away". `is_called` is false on an EMPTY table so the first id is 1, not 2: passing a bare
--     `true` makes a fresh cloud deployment's very first workspace id 2, which reads as a bug to
--     whoever finds it.
SELECT setval(
  pg_get_serial_sequence('workspaces','id'),
  GREATEST(COALESCE((SELECT MAX("id") FROM "workspaces"), 0), 1),
  COALESCE((SELECT MAX("id") FROM "workspaces"), 0) > 0
);--> statement-breakpoint
-- 2. A Default workspace for EVERY account, including accounts that never had a team.
--    The three-level name CASE exists because `workspaces_account_name` is unique and a user may
--    already own a team called "Default". The third form embeds the account id, so it cannot
--    collide with the first two for the same account.
INSERT INTO "workspaces" ("account_id", "name", "is_default", "created_at")
SELECT a."id",
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."account_id" = a."id" AND w."name" = 'Default')
           THEN 'Default'
         WHEN NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."account_id" = a."id" AND w."name" = 'Default workspace')
           THEN 'Default workspace'
         ELSE 'Default (workspace ' || a."id" || ')'
       END,
       true, now()
  FROM "accounts" a
 WHERE NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w."account_id" = a."id" AND w."is_default");--> statement-breakpoint
-- 2b. ONE DEFAULT PER ACCOUNT, AS A DATABASE FACT. Created after the backfill so a hand-corrupted
--     database fails on a statement whose meaning is obvious. This is what makes
--     ensureDefaultWorkspace's "INSERT … ON CONFLICT DO NOTHING then re-SELECT" race-safe: it runs
--     on effectively every request, and two concurrent calls for an account with no default would
--     otherwise both SELECT nothing and both INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_one_default" ON "workspaces" USING btree ("account_id") WHERE "is_default";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Tenancy as a constraint. `workspace_id` arrives in a REQUEST BODY, so a plain
	-- `REFERENCES workspaces(id)` would accept (account 2, workspace 10) where workspace 10 belongs
	-- to account 1 — both halves individually valid. NAMED so Postgres quotes it in the violation
	-- message and a grep for the name finds a live constraint.
	CONSTRAINT "workspace_repos_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade,
	CONSTRAINT "workspace_repos_repo_account_fk" FOREIGN KEY ("repo_id","account_id") REFERENCES "repos"("id","account_id") ON DELETE cascade
);--> statement-breakpoint
-- EXACTLY ONE WORKSPACE PER REPO, AS A DATABASE FACT — and the upsert conflict target for
-- assignReposToWorkspace, so assigning a repo elsewhere is a MOVE and no code path can produce a
-- second membership row.
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_repos_account_repo" ON "workspace_repos" USING btree ("account_id","repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_repos_account_workspace_idx" ON "workspace_repos" USING btree ("account_id","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_repos_repo_idx" ON "workspace_repos" USING btree ("repo_id");--> statement-breakpoint
-- 3. D4's TIE-BREAK: a repo in 2+ teams keeps its EARLIEST assignment (lowest team_repos.id).
--    Written as a correlated MIN() rather than DISTINCT ON, which SQLite does not have and which
--    would therefore make the two dialects' files structurally different for no reason. The
--    account predicate in the subquery is redundant (repos.id is a global PK, so repo_id already
--    implies the account) and is spelled anyway so tenancy is visible in the statement.
DO $$
BEGIN
  IF to_regclass('public.team_repos') IS NOT NULL THEN
    INSERT INTO "workspace_repos" ("account_id", "workspace_id", "repo_id", "created_at")
    SELECT tr."account_id", tr."team_id", tr."repo_id", tr."created_at"
      FROM "team_repos" tr
     WHERE tr."id" = (
             SELECT MIN(tr2."id") FROM "team_repos" tr2
              WHERE tr2."repo_id" = tr."repo_id" AND tr2."account_id" = tr."account_id")
    ON CONFLICT ("account_id", "repo_id") DO NOTHING;
  END IF;
END $$;--> statement-breakpoint
-- 4. Every repo with no resulting row → that account's Default. Covers repos that were in no team
--    at all AND (on a replay) anything step 3 could not place. UNGUARDED — see the header.
INSERT INTO "workspace_repos" ("account_id", "workspace_id", "repo_id", "created_at")
SELECT r."account_id", w."id", r."id", now()
  FROM "repos" r
  JOIN "workspaces" w ON w."account_id" = r."account_id" AND w."is_default"
 WHERE NOT EXISTS (SELECT 1 FROM "workspace_repos" wr WHERE wr."repo_id" = r."id")
ON CONFLICT ("account_id", "repo_id") DO NOTHING;--> statement-breakpoint
-- 5. Child first (team_repos FKs teams), then the parent. Leaving them behind would leave a
--    second, differently-keyed answer to "which repos am I looking at" in every database.
DROP TABLE IF EXISTS "team_repos";--> statement-breakpoint
DROP TABLE IF EXISTS "teams";
