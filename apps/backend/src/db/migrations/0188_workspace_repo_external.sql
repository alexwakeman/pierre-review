-- EXTERNAL REPOS (2026-11-12; docs/DATA-MODEL.md § External repos). CORE, additive.
--
--   workspace_repos.mode   'watched' (the default: every existing membership) | 'external' — a repo
--                          the team changes but does not maintain. Its PRs are not watched (only its
--                          PROJECT PRs reach Open PRs and Pending), it is left out of Reports, and no
--                          automatic action runs on it. Read only through db/external-repos.ts.
ALTER TABLE `workspace_repos` ADD COLUMN `mode` text NOT NULL DEFAULT 'watched';
