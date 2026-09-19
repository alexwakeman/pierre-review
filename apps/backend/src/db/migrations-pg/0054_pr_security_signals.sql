-- Postgres twin of migrations/0067_pr_security_signals.sql. Read that file for the reasoning:
-- four small DERIVED columns on `pull_requests` (`dependency_vendor`, `security_fix`,
-- `advisory_ids`, `security_checked_at`) read at sync from the PR's title, branch, labels and FULL
-- `bodyText` — no bodies stored, a three-state write (a body that was not received writes
-- nothing), never `search_index` (its 4,000-character cap cuts Dependabot's footer off), and
-- `security_checked_at` NULL is the backfill's worklist.
--
-- The `workspace_reviewers` UPDATEs upgrade six newly-known automation logins (plus Semgrep's
-- per-org App) whose stored role/kind would otherwise beat the new login seed forever — the
-- 0040/0041 precedent, with the same three conditions.
--
-- Only spelling difference from the sqlite file: `regexp_replace(…, '\[bot\]$', '')` rather
-- than `replace(…, '[bot]', '')` (the documented divergence; each is idiomatic for its dialect).
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "dependency_vendor" text;
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "security_fix" text;
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "advisory_ids" jsonb;
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "security_checked_at" timestamp with time zone;
UPDATE "workspace_reviewers"
SET "role" = 'dependency'
WHERE "source" <> 'manual'
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN
      ('snyk-io', 'aikido-autofix', 'mend-for-github-com')
  );
UPDATE "workspace_reviewers"
SET "role" = 'quality_check'
WHERE "source" <> 'manual'
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('endor-labs-pro')
       OR lower("github_login") LIKE 'semgrep-code-%' OR lower("github_login") LIKE 'semgrepcode-%'
  );
UPDATE "workspace_reviewers"
SET "role" = 'code_agent'
WHERE "source" <> 'manual'
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN
      ('step-security-bot', 'orbisai0security')
  );
UPDATE "workspace_reviewers" SET "kind" = 'snyk', "label" = NULL
WHERE "identity_source" <> 'manual' AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('snyk-io'));
UPDATE "workspace_reviewers" SET "kind" = 'aikido', "label" = NULL
WHERE "identity_source" <> 'manual' AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('aikido-autofix'));
UPDATE "workspace_reviewers" SET "kind" = 'mend', "label" = NULL
WHERE "identity_source" <> 'manual' AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('mend-for-github-com'));
UPDATE "workspace_reviewers" SET "kind" = 'endor', "label" = NULL
WHERE "identity_source" <> 'manual' AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('endor-labs-pro'));
UPDATE "workspace_reviewers" SET "kind" = 'semgrep', "label" = NULL
WHERE "identity_source" <> 'manual' AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (SELECT "id" FROM "users" WHERE lower("github_login") LIKE 'semgrep-code-%' OR lower("github_login") LIKE 'semgrepcode-%');
UPDATE "workspace_reviewers" SET "kind" = 'step_security', "label" = NULL
WHERE "identity_source" <> 'manual' AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('step-security-bot'));
UPDATE "workspace_reviewers" SET "kind" = 'orbisai', "label" = NULL
WHERE "identity_source" <> 'manual' AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('orbisai0security'));
