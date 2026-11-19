-- AI FIX: WHAT A PUSH LEFT (2026-11-18; docs/CLAUDE-REVIEW.md § Push when done). CORE, additive.
--
--   ai_fixes.pushed_commit_sha      the commit the push left on the branch. NULL = not pushed, or pushed before
--                                   this migration (the AI Fix tab then shows the branch only).
--   ai_fixes.pushed_automatically   the push was not a press ("Push when done", "Push automatically", the
--                                   Dependencies policy). 0 on every existing row.
ALTER TABLE `ai_fixes` ADD COLUMN `pushed_commit_sha` text;--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD COLUMN `pushed_automatically` integer NOT NULL DEFAULT 0;
