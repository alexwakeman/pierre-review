-- AI FIX'S OWN REVIEW LOOP (2026-11-18; docs/CLAUDE-REVIEW.md § AI Fix → The review loop). CORE, additive.
-- After each fix turn (manual, auto, dependency automation's) Ensemble reviews the fix's OWN work — a LOCAL
-- commit in its clone cache, never pushed — and the agent answers every point in another fix turn, up to N
-- rounds (Settings → AI → AI Fix → Review rounds). Nothing is pushed until the loop ends; then the closing
-- review becomes the PR's AI review at the pushed head (ai_fixes.loop_review_id). Build's story_build_* loop
-- tables are untouched. `fix_id` is soft (ai_fixes has no (id, account_id) unique): every query is
-- account-scoped and both delete paths prune these rows with the fix's.
--
-- AiFixLoopState: NULL (never ran) | 'reviewing' | 'fixing' | 'done' | 'stopped'
-- AiFixLoopStop:  'clean' | 'rounds' | 'cannot_meet' | 'budget' | 'stopped' | 'review_failed' | 'fix_failed' |
--                 'no_reviewer' | 'session_closed' | 'interrupted' | 'not_pushable'
ALTER TABLE `ai_fixes` ADD COLUMN `loop_state` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD COLUMN `loop_round` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD COLUMN `loop_first_round` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD COLUMN `loop_rounds` integer;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD COLUMN `loop_stop` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD COLUMN `loop_base_sha` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD COLUMN `loop_review_id` integer;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD COLUMN `loop_finished_at` integer;
--> statement-breakpoint
-- ONE ROW PER CODE-REVIEW RUN of a round (one provider half): the same columns + JSON as claude_reviews.
CREATE TABLE `ai_fix_loop_reviews` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `fix_id` integer NOT NULL,
  `round` integer NOT NULL,
  `repo_id` integer NOT NULL,
  `base_sha` text NOT NULL,
  `head_sha` text NOT NULL,
  `local_ref` text,
  `work_key` text,
  `provider` text,
  `model` text,
  `effort` text,
  `pair_role` text,
  -- The round's place in ITS loop run (step 1..rounds+1; > rounds = the closing review) and that run's N, both
  -- fixed at the run's start: a reader's follow-up runs are contiguous, so neither is derivable later.
  `step` integer,
  `rounds` integer,
  `status` text NOT NULL,
  `review_mode` text,
  `summary` text,
  `verdict` text,
  `follow_up` text,
  `pair_consolidation` text,
  `failure_reason` text,
  `cost_usd` real,
  `input_tokens` integer,
  `output_tokens` integer,
  `num_turns` integer,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_fix_loop_reviews_run` ON `ai_fix_loop_reviews` (`fix_id`,`round`,`provider`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_fix_loop_reviews_id_account` ON `ai_fix_loop_reviews` (`id`,`account_id`);
--> statement-breakpoint
CREATE INDEX `ai_fix_loop_reviews_account_idx` ON `ai_fix_loop_reviews` (`account_id`,`fix_id`,`round`);
--> statement-breakpoint
-- The findings of one run, plus the fix agent's answer to each.
CREATE TABLE `ai_fix_loop_findings` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `review_id` integer NOT NULL,
  `fix_id` integer NOT NULL,
  `round` integer NOT NULL,
  `severity` text NOT NULL,
  `path` text NOT NULL,
  `line` integer,
  `side` text DEFAULT 'RIGHT' NOT NULL,
  `title` text NOT NULL,
  `body` text NOT NULL,
  `suggestion` text,
  `diff_hunk` text,
  `anchored` integer DEFAULT false NOT NULL,
  `file_in_diff` integer DEFAULT false NOT NULL,
  `prior_finding_id` integer,
  `lens` text,
  `merged_into` integer,
  `ref` text,
  `response` text,
  `response_text` text,
  `response_round` integer,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `ai_fix_loop_findings_review_account_fk` FOREIGN KEY (`review_id`,`account_id`) REFERENCES `ai_fix_loop_reviews`(`id`,`account_id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_fix_loop_findings_review_idx` ON `ai_fix_loop_findings` (`review_id`);
--> statement-breakpoint
CREATE INDEX `ai_fix_loop_findings_account_idx` ON `ai_fix_loop_findings` (`account_id`,`fix_id`,`round`);
--> statement-breakpoint
-- The round's story check (only when the PR's ticket criteria are in the fix).
CREATE TABLE `ai_fix_loop_story_checks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `fix_id` integer NOT NULL,
  `round` integer NOT NULL,
  `status` text NOT NULL,
  `provider` text,
  `model` text,
  `assessment` text,
  `claims` text,
  `claim_verdicts` text,
  `failure_reason` text,
  `cost_usd` real,
  `input_tokens` integer,
  `output_tokens` integer,
  `num_turns` integer,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_fix_loop_story_checks_round` ON `ai_fix_loop_story_checks` (`fix_id`,`round`);
--> statement-breakpoint
CREATE INDEX `ai_fix_loop_story_checks_account_idx` ON `ai_fix_loop_story_checks` (`account_id`,`fix_id`);
--> statement-breakpoint
-- The fix agent's answer per criterion / missing item after a round's review.
CREATE TABLE `ai_fix_loop_ac_responses` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `fix_id` integer NOT NULL,
  `round` integer NOT NULL,
  `ref` text NOT NULL,
  `response` text NOT NULL,
  `text` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_fix_loop_ac_responses_ref` ON `ai_fix_loop_ac_responses` (`fix_id`,`round`,`ref`);
--> statement-breakpoint
CREATE INDEX `ai_fix_loop_ac_responses_account_idx` ON `ai_fix_loop_ac_responses` (`account_id`,`fix_id`);
