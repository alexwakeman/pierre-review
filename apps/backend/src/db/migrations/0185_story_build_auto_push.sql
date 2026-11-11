-- IMPLEMENT STORY: "PUSH AND OPEN THE PULL REQUEST WHEN THE BUILD FINISHES" (2026-11-11;
-- docs/STORY-BUILD.md § Push automatically). CORE, additive.
--
--   story_builds.auto_push              the reader's opt-in (Start panel, or the tab until the build pushed).
--                                       0 = off (the default): nothing is pushed until the reader presses Push.
--   story_builds.auto_push_claimed_at   THE CLAIM: set by compare-and-set (auto_push = 1 AND NULL) BEFORE any
--                                       GitHub write; never cleared, so the automatic push runs once per build.
--   story_builds.auto_push_error        why the automatic push did not land (one sentence); NULL otherwise.
--   story_build_repos.push_error_code   the code beside `push_error` (`BRANCH_EXISTS`, …), so the tab can offer
--   story_build_prs.push_error_code     the rename after a reload or an automatic push. NULL = none.
ALTER TABLE `story_builds` ADD COLUMN `auto_push` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `auto_push_claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `auto_push_error` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `push_error_code` text;
--> statement-breakpoint
ALTER TABLE `story_build_prs` ADD COLUMN `push_error_code` text;
