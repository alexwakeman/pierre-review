-- THE AI PROVIDER CHOICE + RUN LABELLING (docs/CODEX-PLAN.md Phase 4).
--
-- accounts.ai_provider: the Settings → AI choice ('claude' | 'codex' | 'auto'); NULL = never chosen
-- (reads as 'auto'). An explicitly set LIMN_AI_PROVIDER wins over it.
--
-- `provider` on every agentic run table that stores a model: which provider RAN the run. Nullable;
-- NULL on every older row, read as Claude unless the row's `model` is a Codex id (packages/shared
-- `aiRunProvider`). From now on `model` stores the model that ran, never the one asked for.
-- ai_fixes.plan_provider / plan_model: what the latest planning pass ran on.
-- reference_docs / reference_doc_chat_messages gain `model` too (they stored none).
-- Additive only.
ALTER TABLE `accounts` ADD `ai_provider` text;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `claude_review_chat_messages` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `ticket_reviews` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `ticket_review_pr_cards` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `ci_reviews` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `claude_thread_checks` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `plan_provider` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `plan_model` text;
--> statement-breakpoint
ALTER TABLE `sprint_paths` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `sequence_diagrams` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `story_docs_alignments` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `reference_docs` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `reference_docs` ADD `model` text;
--> statement-breakpoint
ALTER TABLE `reference_doc_chat_messages` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `reference_doc_chat_messages` ADD `model` text;
