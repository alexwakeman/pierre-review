-- Brand the automations that were stored as `in_house` — the bucket labelled "In-house AI".
--
-- WHY THIS IS NEEDED AT ALL, and why it is the same shape as `0053`. The classifier's step 2
-- fires on `githubType === 'Bot'` and assigns `fp?.tool ?? 'in_house'`, and until now there was
-- no step between it and the AI-reviewer login check. So EVERY non-reviewer integration — every
-- quality gate, dependency bot, code agent, release and housekeeping automation — was stored as
-- "In-house AI": 25 of 37 such rows on the dev corpus, holding sonarqubecloud, dependabot[bot],
-- github-actions[bot], gitguardian, socket-security, google-cla and jit-ci. They all rendered
-- with the same grey chip and the same wrong name, on the one screen that exists to classify them.
--
-- The stored `kind` wins over any derivation on read, so widening the vocabulary in code alone
-- would only ever reach an install nobody had opened the Bots tab on.
--
-- ── THE THREE CONDITIONS ARE EACH LOAD-BEARING ──────────────────────────────────────────────
--
--   `identity_source <> 'manual'`  — a vendor a HUMAN named is never re-derived. Identity is
--                                    owned by `identity_source`, judgement by `source`; this
--                                    migration touches only the identity half, so a manual
--                                    "not a bot" verdict elsewhere on the row is unaffected.
--   `kind IN ('in_house','vendor')` — only the UNBRANDED kinds are upgraded. A row already
--                                     carrying a real brand is left alone even if the login
--                                     vocabulary would now claim it, because that brand came
--                                     from a stronger signal (a vendor-login or fingerprint hit)
--                                     and silently overwriting it is how a correction gets lost.
--   `label = NULL`                  — the label is a CACHE of the kind's display name, and the
--                                     old rows hold the literal "In-house AI" or the bare login.
--                                     Leaving it would show "In-house AI" beside a SonarQube
--                                     chip. NULL means "use the brand name", which is exactly
--                                     what the reader wants and what `label` is documented to do.
--
-- `[bot]`-suffix stripping is the same rule as 0053: `dependabot` and `dependabot[bot]` are
-- separate `users` rows with different node ids, and covering one spelling splits one actor.
--
-- ⚠ IT COVERS THE AI-REVIEW VENDORS TOO, not only the new families. Found while checking the
-- result on a live database: `deepsource-io` and `github-code-quality` were also sitting at
-- `in_house`, because their rows were written before those logins joined `REVIEW_BOTS`. The
-- staleness is identical and so is the fix — the stored kind wins on read, so a login joining a
-- vocabulary never reaches an actor that has already been classified.
UPDATE `workspace_reviewers`
SET `kind` = 'allcontributors', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('allcontributors')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'allstar', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('allstar')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'backport', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('backport', 'lumberbot-app', 'meeseeksdev')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'baz', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('baz-reviewer')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'bito', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('bito-code-review')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'bulldozer', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('bulldozer')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'changesets', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('changeset-bot', 'changesets')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'cla_assistant', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('cla-assistant', 'cla-bot', 'claassistant')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'codacy', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('codacy-bot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'codeclimate', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('codeclimate')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'codecov', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('codecov')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'codefactor', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('codefactor-io')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'codegen', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('codegen-sh')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'coderabbit', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('coderabbitai')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'codesandbox', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('codesandbox-ci')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'codex', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('chatgpt-codex-connector')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'copilot', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('copilot-pull-request-reviewer')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'coveralls', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('coveralls')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'crowdin', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('crowdin-bot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'cursor', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('cursor')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'dco', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('dco')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'deepsource', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('deepsource-io', 'deepsourcebot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'deepsource_autofix', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('deepsource-autofix')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'dependabot', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('dependabot', 'dependabot-preview')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'depfu', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('depfu')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'devin', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('devin-ai-integration')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'ellipsis', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('ellipsis-dev')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'entelligence', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('entelligence-ai-pr-reviews')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'gitguardian', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('gitguardian')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'github_actions', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('github-actions')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'github_advanced_security', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('github-advanced-security')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'github_code_quality', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('github-code-quality')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'gitpod', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('gitpod-io')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'google_cla', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('google-cla', 'googlebot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'graphite', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('graphite-app')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'greenkeeper', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('greenkeeper')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'greptile', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('greptile-apps')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'hound', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('houndci-bot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'imgbot', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('imgbot', 'imgbotapp')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'jit', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('jit-ci')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'kodiak', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('kodiak', 'kodiakhq')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'korbit', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('korbit-ai')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'lock_bot', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('lock')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'mergify', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('mergify')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'meta_cla', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('facebook-github-bot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'mintlify', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('mintlify')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'netlify', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('netlify')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'pre_commit_ci', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('pre-commit-ci')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'pyup', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('pyup-bot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'qodo', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('codiumai-pr-agent-free', 'qodo-ai', 'qodo-merge', 'qodo-merge-for-open-source', 'qodo-merge-pro')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'release_drafter', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('release-drafter')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'release_please', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('autorelease', 'release-please', 'releaser')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'renovate', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('renovate', 'renovate-bot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'restyled', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('restyled-io')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'semantic_pr', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('semantic-pull-request')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'semantic_release', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('semantic-release', 'semantic-release-bot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'semgrep', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('semgrep-app')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'sizebot', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('diffray-bot', 'react-sizebot', 'sizebot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'snyk', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('snyk-bot')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'socket', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('socket-security')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'sonarqube', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('sonarcloud', 'sonarqubecloud')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'sourcery', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('sourcery-ai')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'stale_bot', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('stale')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'sweep', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('sweep-ai')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'transifex', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('transifex-integration')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'trunk', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('trunk-io')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'vercel', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('vercel')
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `kind` = 'welcome_bot', `label` = NULL
WHERE `identity_source` <> 'manual'
  AND `kind` IN ('in_house', 'vendor')
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN ('welcome')
  );
