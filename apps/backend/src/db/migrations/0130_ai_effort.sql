-- THE EFFORT SETTING (Settings → AI → Effort) + the effort each run used.
--
-- accounts.ai_effort: the chosen level for agentic runs ('low' | 'medium' | 'high' | 'xhigh' | 'max');
-- NULL = never chosen (Default: Claude medium, Codex by depth). An explicitly set REVIEW_EFFORT wins.
-- claude_reviews.effort, ai_fixes.effort / plan_effort: the effort the run (the build, the latest
-- planning pass) actually used, for its label. NULL on every older row. Additive only.
ALTER TABLE `accounts` ADD `ai_effort` text;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `effort` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `effort` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `plan_effort` text;
