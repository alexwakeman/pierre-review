-- AI VENDOR SIGNALS (2026-11-25; docs/AI-ADOPTION-REPORT.md § Detection). CORE, additive, no AI.
--
-- Which AI coding tools touched a pull request, read at sync by the ONE shared detector
-- (packages/shared/src/ai-vendor-detect.ts) while the text is in hand. Only the VERDICT is stored,
-- never the text (lean storage): commit messages and PR descriptions stay unstored.
--   pull_requests.ai_signals             JSON [{vendor, source}] from the PR's own title, description,
--                                        branch and author. NULL = never scanned, [] = scanned clean
--   pull_requests.ai_signals_version     the detector version of that scan (and of its commits')
--   pull_requests.ai_signals_checked_at  when it was scanned
--   commits.ai_signals                   JSON from the commit's author, committer and message
--
-- No SQL backfill: NULL means "not scanned". sync/backfill-ai-signals.ts reads the last 90 days
-- once, by node id, bounded and budget-aware.
ALTER TABLE `pull_requests` ADD `ai_signals` text;
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `ai_signals_version` integer;
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `ai_signals_checked_at` integer;
--> statement-breakpoint
ALTER TABLE `commits` ADD `ai_signals` text;
