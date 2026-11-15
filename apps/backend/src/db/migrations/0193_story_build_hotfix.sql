-- IMPLEMENT STORY: HOTFIX BUILDS (2026-11-15; docs/STORY-BUILD.md § Hotfix builds, docs/RELEASES.md § Hotfix).
-- CORE, additive. A hotfix build fixes each repository on its LATEST RELEASE and ports the fix to the
-- default branch in the same sandbox; Push opens two PRs per repository.
--
--   story_builds.hotfix                       1 = "Treat as a hotfix" was ticked at Start. 0 = an ordinary build.
--   story_build_repos.hotfix_tag              the latest release (or hotfix) tag the release checkout starts at;
--                                             NULL on an ordinary build and on a READ-ONLY repository.
--   story_build_repos.read_only               1 = no release yet: the agent may read it, its changes are refused.
--   story_build_repos.main_*                  the MAIN FIX: the default-branch checkout's base, sandbox path,
--                                             patch (+ sha, numbers, files, commit message), its status
--                                             (NULL | ready | skipped | failed | pushed) and its push record.
--   story_build_repos.hotfix_branch_json      Push's record of `hotfix/<tag>`: created or found, moved past the
--                                             release commit, and the PRs already on it.
ALTER TABLE `story_builds` ADD COLUMN `hotfix` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `hotfix_tag` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `read_only` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_base_ref` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_base_sha` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_sandbox_path` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_patch` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_patch_sha` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_stat_json` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_files_changed_json` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_commit_message` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_status` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_error` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_pushed_branch` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_pushed_pr_number` integer;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_pushed_pr_url` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_pushed_commit_sha` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_pushed_at` integer;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_push_error` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `main_push_error_code` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `hotfix_branch_json` text;
