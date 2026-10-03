-- AI FIX: TWO ENTRY POINTS, A PER-CHANGE REPORT, AND WHO STARTED THE RUN.
--
-- ai_fixes.trigger (text): 'manual' | 'auto' — 'auto' is the auto-review agent calling
-- startReviewFix. NULL on older rows reads as 'manual'.
-- ai_fixes.review_items (JSON AiFixReviewItem[]): seed 'review' only — every item of the Claude
-- review the run was given, each with the ref the agent must cite (F1, P1, T1, S1-AC2, S1-M1, C1)
-- and `included: false` for the ones left out for the prompt budget. Written at insert.
-- ai_fixes.change_report (JSON AiFixChangeReport): the agent's per-file report (what changed, why,
-- which refs) plus the refs it deliberately did not fix, validated server-side. Written on success.
-- All nullable, no backfill. The removed 'comments' seed's comment_targets / comment_verdicts stay
-- (old rows keep their data; nothing reads them).
-- The Postgres twin is migrations-pg/0065_ai_fix_change_report.sql.
ALTER TABLE `ai_fixes` ADD `trigger` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `review_items` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `change_report` text;
