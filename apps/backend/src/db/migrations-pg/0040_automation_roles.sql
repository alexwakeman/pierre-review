-- Postgres twin of sqlite `0053_automation_roles.sql`. Read that file for the full reasoning:
-- the stored role beats the login seed on read, so widening the vocabularies in code does nothing
-- for an actor that has already been classified, and `github-actions` would keep sitting in the
-- AI-reviewer ROI cohort with 385 submitted reviews behind it.
--
-- `source <> 'manual'` is the safety condition — a role a person chose is never re-derived.
--
-- The only spelling difference from the sqlite file: `regexp_replace(…, '\[bot\]$', '')` instead
-- of `replace(…, '[bot]', '')`. Same operation — strip the `[bot]` suffix so the two `users` rows
-- that are the same actor (`dependabot` and `dependabot[bot]` have different GitHub node ids)
-- cannot land in different roles.
UPDATE "workspace_reviewers"
SET "role" = 'dependency'
WHERE "source" <> 'manual'
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN (
      'dependabot', 'dependabot-preview', 'renovate', 'renovate-bot',
      'snyk-bot', 'pyup-bot', 'greenkeeper', 'depfu'
    )
  );
UPDATE "workspace_reviewers"
SET "role" = 'code_agent'
WHERE "source" <> 'manual'
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN (
      'devin-ai-integration', 'sweep-ai', 'codegen-sh', 'deepsource-autofix',
      'pre-commit-ci', 'restyled-io', 'imgbot', 'imgbotapp',
      'transifex-integration', 'crowdin-bot', 'mintlify', 'allstar'
    )
  );
UPDATE "workspace_reviewers"
SET "role" = 'release'
WHERE "source" <> 'manual'
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN (
      'mergify', 'kodiak', 'kodiakhq', 'bulldozer', 'release-please', 'releaser',
      'semantic-release', 'semantic-release-bot', 'release-drafter', 'changeset-bot',
      'changesets', 'autorelease', 'lumberbot-app', 'meeseeksdev', 'backport'
    )
  );
UPDATE "workspace_reviewers"
SET "role" = 'housekeeping'
WHERE "source" <> 'manual'
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN (
      'cla-bot', 'cla-assistant', 'claassistant', 'google-cla', 'googlebot',
      'facebook-github-bot', 'dco', 'stale', 'welcome', 'lock', 'allcontributors',
      'semantic-pull-request', 'sizebot', 'react-sizebot', 'diffray-bot',
      'codesandbox-ci', 'netlify', 'vercel', 'gitpod-io'
    )
  );
-- Supersedes pg 0029's narrower list rather than repeating it.
UPDATE "workspace_reviewers"
SET "role" = 'quality_check'
WHERE "source" <> 'manual'
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN (
      'sonarqubecloud', 'sonarcloud', 'codecov', 'codeclimate', 'codefactor-io',
      'houndci-bot', 'coveralls', 'codacy-bot',
      'github-actions', 'jit-ci', 'socket-security', 'gitguardian',
      'semgrep-app', 'trunk-io'
    )
  );
