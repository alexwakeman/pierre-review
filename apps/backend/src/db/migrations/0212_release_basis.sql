-- RELEASES WITHOUT VERSION TAGS (2026-11-19; docs/RELEASES.md § Releasing without version tags). CORE,
-- additive. Per releasable (workspace, repo): what a release is cut from — NULL = auto (merged pull
-- requests when the repo has no version tag), 'tags', 'prs'. Per release item: the basis it was cut on.
ALTER TABLE `workspace_release_repos` ADD COLUMN `release_basis` text;
--> statement-breakpoint
ALTER TABLE `release_items` ADD COLUMN `basis` text;
