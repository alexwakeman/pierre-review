-- Re-derive `workspace_reviewers.role` against the five automation vocabularies.
--
-- WHY A MIGRATION IS REQUIRED AND NOT JUST A LONGER LIST IN CODE.
--
-- `reviewerRoleForUser` applies the login seed FIRST and then lets a stored `workspace_reviewers`
-- row overwrite it. That ordering is correct — an explicit row must beat a default — but it means
-- adding a login to `QUALITY_CHECK_BOTS` (or to any of the four new lists) has NO EFFECT on an
-- actor that has already been classified, and the lazy classifier stamps a row the first time
-- anyone opens the Bots tab. So on any install that has used the product, `github-actions` keeps
-- the `role: 'review'` it was given when 'review' was the only fallback, and stays in the
-- AI-reviewer ROI cohort no matter what the code says.
--
-- Measured on the dev corpus before this ran: `github-actions` + `github-actions[bot]` held 385
-- submitted reviews and 3,116 comments between them while roled 'review' — the single largest
-- "AI reviewer" in the account was a CI runner. `dependabot`/`dependabot[bot]` (738 authored PRs)
-- were roled 'review' as well, an actor that has never reviewed anything.
--
-- `source <> 'manual'` is the whole safety condition: a role a PERSON chose is never re-derived,
-- exactly as migration 0042's backfill had it. The judgement half is owned by `source`.
--
-- The `[bot]` suffix is stripped rather than each login being listed twice, because the SAME
-- ACTOR exists as two `users` rows on real accounts (`dependabot` and `dependabot[bot]` have
-- different GitHub node ids) and a list that covers one spelling and not the other splits an
-- actor across two roles. `replace()` is safe here: no GitHub login may contain `[` or `]`, so
-- the substring can only ever appear as the suffix. The Postgres twin uses `regexp_replace(…,
-- '\[bot\]$', '')`, which is the same operation spelled in that dialect's idiom.
UPDATE `workspace_reviewers`
SET `role` = 'dependency'
WHERE `source` <> 'manual'
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN (
      'dependabot', 'dependabot-preview', 'renovate', 'renovate-bot',
      'snyk-bot', 'pyup-bot', 'greenkeeper', 'depfu'
    )
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `role` = 'code_agent'
WHERE `source` <> 'manual'
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN (
      'devin-ai-integration', 'sweep-ai', 'codegen-sh', 'deepsource-autofix',
      'pre-commit-ci', 'restyled-io', 'imgbot', 'imgbotapp',
      'transifex-integration', 'crowdin-bot', 'mintlify', 'allstar'
    )
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `role` = 'release'
WHERE `source` <> 'manual'
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN (
      'mergify', 'kodiak', 'kodiakhq', 'bulldozer', 'release-please', 'releaser',
      'semantic-release', 'semantic-release-bot', 'release-drafter', 'changeset-bot',
      'changesets', 'autorelease', 'lumberbot-app', 'meeseeksdev', 'backport'
    )
  );--> statement-breakpoint
UPDATE `workspace_reviewers`
SET `role` = 'housekeeping'
WHERE `source` <> 'manual'
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN (
      'cla-bot', 'cla-assistant', 'claassistant', 'google-cla', 'googlebot',
      'facebook-github-bot', 'dco', 'stale', 'welcome', 'lock', 'allcontributors',
      'semantic-pull-request', 'sizebot', 'react-sizebot', 'diffray-bot',
      'codesandbox-ci', 'netlify', 'vercel', 'gitpod-io'
    )
  );--> statement-breakpoint
-- Last, and it supersedes 0042's narrower list rather than repeating it: the eight original
-- static-analysis logins plus the CI runners and security scanners added alongside the new roles.
UPDATE `workspace_reviewers`
SET `role` = 'quality_check'
WHERE `source` <> 'manual'
  AND `author_user_id` IN (
    SELECT `id` FROM `users` WHERE replace(lower(`github_login`), '[bot]', '') IN (
      'sonarqubecloud', 'sonarcloud', 'codecov', 'codeclimate', 'codefactor-io',
      'houndci-bot', 'coveralls', 'codacy-bot',
      'github-actions', 'jit-ci', 'socket-security', 'gitguardian',
      'semgrep-app', 'trunk-io'
    )
  );
