-- Postgres twin of sqlite `0054_automation_vendor_kinds.sql`. Read that file for the reasoning:
-- every non-reviewer integration was stored as `kind: 'in_house'` (the "In-house AI" bucket)
-- because the classifier had no step between the AI-reviewer login check and the githubType
-- fallback, and the stored kind wins on read.
--
-- Three conditions, each load-bearing: `identity_source <> 'manual'` (never re-derive a vendor a
-- human named), `kind IN ('in_house','vendor')` (only upgrade the UNBRANDED kinds — a row with a
-- real brand came from a stronger signal), and `label = NULL` (the label caches the kind's
-- display name and the old rows hold the literal "In-house AI").
--
-- Only spelling difference from the sqlite file: `regexp_replace(…, '\[bot\]$', '')` rather
-- than `replace(…, '[bot]', '')`.
UPDATE "workspace_reviewers"
SET "kind" = 'allcontributors', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('allcontributors')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'allstar', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('allstar')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'backport', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('backport', 'lumberbot-app', 'meeseeksdev')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'baz', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('baz-reviewer')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'bito', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('bito-code-review')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'bulldozer', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('bulldozer')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'changesets', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('changeset-bot', 'changesets')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'cla_assistant', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('cla-assistant', 'cla-bot', 'claassistant')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'codacy', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('codacy-bot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'codeclimate', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('codeclimate')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'codecov', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('codecov')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'codefactor', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('codefactor-io')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'codegen', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('codegen-sh')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'coderabbit', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('coderabbitai')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'codesandbox', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('codesandbox-ci')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'codex', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('chatgpt-codex-connector')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'copilot', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('copilot-pull-request-reviewer')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'coveralls', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('coveralls')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'crowdin', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('crowdin-bot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'cursor', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('cursor')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'dco', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('dco')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'deepsource', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('deepsource-io', 'deepsourcebot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'deepsource_autofix', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('deepsource-autofix')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'dependabot', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('dependabot', 'dependabot-preview')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'depfu', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('depfu')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'devin', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('devin-ai-integration')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'ellipsis', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('ellipsis-dev')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'entelligence', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('entelligence-ai-pr-reviews')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'gitguardian', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('gitguardian')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'github_actions', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('github-actions')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'github_advanced_security', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('github-advanced-security')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'github_code_quality', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('github-code-quality')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'gitpod', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('gitpod-io')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'google_cla', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('google-cla', 'googlebot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'graphite', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('graphite-app')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'greenkeeper', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('greenkeeper')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'greptile', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('greptile-apps')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'hound', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('houndci-bot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'imgbot', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('imgbot', 'imgbotapp')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'jit', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('jit-ci')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'kodiak', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('kodiak', 'kodiakhq')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'korbit', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('korbit-ai')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'lock_bot', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('lock')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'mergify', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('mergify')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'meta_cla', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('facebook-github-bot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'mintlify', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('mintlify')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'netlify', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('netlify')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'pre_commit_ci', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('pre-commit-ci')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'pyup', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('pyup-bot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'qodo', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('codiumai-pr-agent-free', 'qodo-ai', 'qodo-merge', 'qodo-merge-for-open-source', 'qodo-merge-pro')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'release_drafter', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('release-drafter')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'release_please', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('autorelease', 'release-please', 'releaser')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'renovate', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('renovate', 'renovate-bot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'restyled', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('restyled-io')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'semantic_pr', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('semantic-pull-request')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'semantic_release', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('semantic-release', 'semantic-release-bot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'semgrep', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('semgrep-app')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'sizebot', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('diffray-bot', 'react-sizebot', 'sizebot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'snyk', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('snyk-bot')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'socket', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('socket-security')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'sonarqube', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('sonarcloud', 'sonarqubecloud')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'sourcery', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('sourcery-ai')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'stale_bot', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('stale')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'sweep', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('sweep-ai')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'transifex', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('transifex-integration')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'trunk', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('trunk-io')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'vercel', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('vercel')
  );
UPDATE "workspace_reviewers"
SET "kind" = 'welcome_bot', "label" = NULL
WHERE "identity_source" <> 'manual'
  AND "kind" IN ('in_house', 'vendor')
  AND "author_user_id" IN (
    SELECT "id" FROM "users" WHERE regexp_replace(lower("github_login"), '\[bot\]$', '') IN ('welcome')
  );
