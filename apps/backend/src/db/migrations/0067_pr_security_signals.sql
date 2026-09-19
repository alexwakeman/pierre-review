-- DEPENDENCY + SECURITY SIGNALS on a pull request (CORE, free, no AI).
--
-- Four small DERIVED columns, read at sync from the PR's own title, branch, labels and FULL
-- `bodyText` by `sync/security-detect.ts`:
--   `dependency_vendor`   — the dependency/remediation tool whose OWN marker is on the PR
--                           (`dependabot/` branch, `[Snyk] ` title, Dependabot's commands footer…).
--                           CONTENT ONLY, never the author login: a Snyk fix opened under a
--                           person's token still carries Snyk's marker, and the author half is
--                           resolved on read, per workspace.
--   `security_fix`        — 'proven' (the tool's own security marker), 'inferred' (Dependabot's
--                           ecosystem-named group with its truncation note), or NULL.
--   `advisory_ids`        — the advisory ids the VENDOR-SELECTED fields name (JSON array), NULL
--                           when there are none. Never the release notes an ordinary bump quotes.
--   `security_checked_at` — when the classification was written. NULL is "never classified" and
--                           is the one-shot backfill's worklist (`sync/backfill-pr-security.ts`).
--
-- ⚠ NO BODIES. Lean storage holds: the body is read in memory during the sync and only the
-- verdict is kept.
--
-- ⚠ THE WRITE IS THREE-STATE, and the four columns move together or not at all. GitHub types
-- `bodyText` String!, so a null can only be a partial response and an absent key a response that
-- never carried the selection — both LEARN NOTHING and write nothing. A string, even '', is a
-- positive statement, and the classification is written whole, NULLs included.
--
-- ⚠ DETECTION CANNOT USE `search_index`. It caps the body at 4,000 characters, and Dependabot's
-- security footer is the LAST line of a body that runs to 65 KB.
--
-- WHY THE `workspace_reviewers` UPDATES ARE HERE. Six automation logins (and Semgrep's per-org
-- `semgrep-code-<org>` App) joined the vocabulary in the same change. The stored role and kind
-- win over the login seed on read, so widening the vocabulary in code alone never reaches a
-- workspace whose Bots tab already classified these logins — the 0053/0054 precedent, with the
-- same three load-bearing conditions: `source <> 'manual'` (a role a PERSON chose is never
-- re-derived), `identity_source <> 'manual'` + `kind IN ('in_house','vendor')` (only an UNBRANDED
-- identity is upgraded, and never one a person named), and `label = NULL` (the label caches the
-- old "In-house AI" name). `[bot]` is stripped because `x` and `x[bot]` are separate `users` rows.
-- The Postgres twin is migrations-pg/0054_pr_security_signals.sql.
ALTER TABLE `pull_requests` ADD `dependency_vendor` text;
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `security_fix` text;
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `advisory_ids` text;
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `security_checked_at` integer;
--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `role` = 'dependency'
WHERE `source` <> 'manual'
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN
      ('snyk-io', 'aikido-autofix', 'mend-for-github-com')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `role` = 'quality_check'
WHERE `source` <> 'manual'
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('endor-labs-pro')
       OR lower(`github_login`) LIKE 'semgrep-code-%' OR lower(`github_login`) LIKE 'semgrepcode-%'
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `role` = 'code_agent'
WHERE `source` <> 'manual'
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN
      ('step-security-bot', 'orbisai0security')
  );--> statement-breakpoint
UPDATE `workspace_reviewers` SET `kind` = 'snyk', `label` = NULL
WHERE `identity_source` <> 'manual' AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('snyk-io'));--> statement-breakpoint
UPDATE `workspace_reviewers` SET `kind` = 'aikido', `label` = NULL
WHERE `identity_source` <> 'manual' AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('aikido-autofix'));--> statement-breakpoint
UPDATE `workspace_reviewers` SET `kind` = 'mend', `label` = NULL
WHERE `identity_source` <> 'manual' AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('mend-for-github-com'));--> statement-breakpoint
UPDATE `workspace_reviewers` SET `kind` = 'endor', `label` = NULL
WHERE `identity_source` <> 'manual' AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('endor-labs-pro'));--> statement-breakpoint
UPDATE `workspace_reviewers` SET `kind` = 'semgrep', `label` = NULL
WHERE `identity_source` <> 'manual' AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (SELECT `id` FROM `users` WHERE lower(`github_login`) LIKE 'semgrep-code-%' OR lower(`github_login`) LIKE 'semgrepcode-%');--> statement-breakpoint
UPDATE `workspace_reviewers` SET `kind` = 'step_security', `label` = NULL
WHERE `identity_source` <> 'manual' AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('step-security-bot'));--> statement-breakpoint
UPDATE `workspace_reviewers` SET `kind` = 'orbisai', `label` = NULL
WHERE `identity_source` <> 'manual' AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('orbisai0security'));
