-- CROSS-REPO AI FIX (2026-11-19; docs/SANDBOX.md § AI Fix sessions → Scope). CORE, additive.
-- Settings → Sandbox → "AI Fix reads every repository": an AI Fix session (manual or auto) loads every workspace
-- repository read only at its default branch beside the PR's own, the most related first, at most
-- AI_FIX_REPOS_MAX (12). NULL = ON (no backfill: an existing row reads as on); 0 = the narrow set (the PR's
-- repository and its ticket's other repositories). Dependency automation's fixes stay narrow either way.
ALTER TABLE `sandbox_workspace_settings` ADD COLUMN `fix_all_repos` integer;
