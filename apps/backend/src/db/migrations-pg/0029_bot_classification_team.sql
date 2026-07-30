-- Per-TEAM bot classification + the quality-check ROLE — the Postgres twin of the sqlite
-- migration 0042_bot_classification_team. Hand-written additive (like 0027/0028), idempotent.
--
-- `team_id` is a NON-NULL sentinel (0 = "No team" AND the inheritance root), never nullable:
-- Postgres treats NULLs as distinct under a UNIQUE index, so a nullable team key would not
-- dedupe and the upsert's ON CONFLICT target would be unreachable. No FK to `teams` — 0 is not
-- a team id, so an FK would reject every default row; deleteTeam cleans up by hand instead.
--
-- `role` ('review' | 'quality_check') is orthogonal to `kind` (vendor identity): a quality-check
-- automation keeps its brand and stays `automated`, and only the METRIC sets narrow to 'review'.
--
-- Both defaults are constants, so existing rows land at (0, 'review') = today's behaviour, with
-- no fan-out. The only real backfill is the role seed at the bottom, which re-roles AUTO rows
-- for known quality-check logins in place and never touches a MANUAL row.
ALTER TABLE "bot_review_classification" ADD COLUMN IF NOT EXISTS "team_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_review_classification" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'review' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "brc_account_author";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brc_account_team_author" ON "bot_review_classification" USING btree ("account_id","team_id","author_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brc_account_team_idx" ON "bot_review_classification" USING btree ("account_id","team_id");--> statement-breakpoint
UPDATE "bot_review_classification"
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
  );
