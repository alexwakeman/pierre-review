-- AI FIX → PLAN MODE (2026-10-16; docs/CLAUDE-REVIEW.md § AI Fix, "Plan mode"). A MANUAL fix may
-- start with a read-only planning pass; the reader steers it by chat and approves it, and the SAME
-- row then runs the build with the approved plan as its brief. An auto fix never plans.
--
--   ai_fixes.plan             JSON AiFixPlan — the latest plan revision (summary bullets, steps,
--                             items it will not address), validated server-side. NULL = no plan.
--   ai_fixes.plan_transcript  JSON AiFixPlanMessage[] — the steering chat (the reader's messages and
--                             Claude's one-line replies), oldest first.
--   ai_fixes.plan_status      'planning' | 'plan_ready' | 'approved' | 'discarded' | 'failed'.
--                             NULL = the run never planned (every older row).
--   ai_fixes.plan_revision    1 for the first plan, +1 per re-plan.
--   ai_fixes.plan_seed        JSON { kind, text } — the frozen, fenced seed every pass re-reads, so a
--                             re-plan and the build see exactly the items the first pass saw.
--                             Server-only; never on the wire.
--   ai_fixes.plan_cost_usd    the planning passes' spend, summed (the build's stays in cost_usd).
-- All nullable, no backfill. The Postgres twin is migrations-pg/0100_ai_fix_plan.sql.
ALTER TABLE `ai_fixes` ADD `plan` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `plan_transcript` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `plan_status` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `plan_revision` integer;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `plan_seed` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `plan_cost_usd` real;
