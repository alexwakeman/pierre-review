-- SETTINGS → FEATURES: THE TOOL SWITCHES, AND A REPO LEFT OUT OF BOT SCORING (2026-11-15). CORE, additive.
--
--   accounts.tool_switches       { ai?, botAnalysis? } booleans, OVERRIDES ONLY (shared tool-switches.ts);
--                                NULL = every default. AI's default: on when the active provider's runtime
--                                is downloaded. Bot comment analysis: on when a scorer is installed.
--   repos.bot_scoring_excluded   true = this repo's bot comments are not scored (Repos & workspaces). The
--                                labels already stored stay. Default 0: every repo is scored, as before.
ALTER TABLE `accounts` ADD COLUMN `tool_switches` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD COLUMN `bot_scoring_excluded` integer DEFAULT 0 NOT NULL;
