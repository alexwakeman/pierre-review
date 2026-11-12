-- IMPLEMENT STORY: THE REVIEW LOOP (2026-11-12; docs/STORY-BUILD.md § The review loop). CORE, additive.
-- "After the build: review and fix, then open the pull request" (the switch is story_builds.auto_push).
-- The loop pushes the branch, reviews it with Limn's own machinery (the code review per target + one story
-- check per round), lets the build agent answer every point, pushes each fix as a NEW commit (never forced)
-- and opens the pull request after the last round. Everything the reviewers say stays HERE (no GitHub
-- comment, no tracker write). Every GitHub write is a `story_build_loop_pushes` row CLAIMED before the write.
--
-- StoryBuildLoopState: NULL (never ran) | 'waiting' | 'pushing' | 'reviewing' | 'fixing' | 'opening' | 'paused' | 'done' | 'stopped' | 'failed'
-- StoryBuildLoopPause: 'budget' | 'session_closed' | 'interrupted' | 'fix_stopped' | 'fix_failed' | 'push_failed' | 'branch_exists' | 'review_failed' | 'build_busy'
ALTER TABLE `story_builds` ADD COLUMN `loop_rounds` integer NOT NULL DEFAULT 3;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `loop_state` text;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `loop_round` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `loop_pause` text;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `loop_error` text;
--> statement-breakpoint
-- While paused: the step Continue goes back to ('pushing' | 'reviewing' | 'fixing' | 'opening'); NULL otherwise.
ALTER TABLE `story_builds` ADD COLUMN `loop_resume` text;
--> statement-breakpoint
-- THE LOOP'S START CLAIM (compare-and-set, once per build; the per-write claims are story_build_loop_pushes rows).
ALTER TABLE `story_builds` ADD COLUMN `loop_claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `loop_finished_at` integer;
--> statement-breakpoint
-- Per target: the branch the loop pushed (no PR yet), its last pushed commit + tree, and the target's own end
-- (NULL | 'pr_opened' | 'manual_push' | 'stopped').
ALTER TABLE `story_build_repos` ADD COLUMN `loop_branch` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `loop_pushed_sha` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `loop_pushed_tree` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `loop_pushed_at` integer;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD COLUMN `loop_ended` text;
--> statement-breakpoint
ALTER TABLE `story_build_prs` ADD COLUMN `loop_branch` text;
--> statement-breakpoint
ALTER TABLE `story_build_prs` ADD COLUMN `loop_pushed_sha` text;
--> statement-breakpoint
ALTER TABLE `story_build_prs` ADD COLUMN `loop_pushed_tree` text;
--> statement-breakpoint
ALTER TABLE `story_build_prs` ADD COLUMN `loop_pushed_at` integer;
--> statement-breakpoint
ALTER TABLE `story_build_prs` ADD COLUMN `loop_ended` text;
--> statement-breakpoint
-- ONE ROW PER GITHUB WRITE OF THE LOOP, CLAIMED BEFORE THE WRITE (never retried automatically).
-- step 'branch' (round 0, the first push) | 'fix' (round k) | 'open' (the PR). attempt grows only on a reader's Continue.
CREATE TABLE `story_build_loop_pushes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `build_id` integer NOT NULL,
  `round` integer NOT NULL,
  `step` text NOT NULL,
  `target_kind` text NOT NULL,
  `target_id` integer NOT NULL,
  `attempt` integer NOT NULL DEFAULT 1,
  `branch` text NOT NULL,
  `parent_sha` text,
  `expect_tree` text,
  `claimed_at` integer NOT NULL,
  `pushed_sha` text,
  `pr_number` integer,
  `pr_url` text,
  `done_at` integer,
  `error` text,
  `error_code` text,
  CONSTRAINT `story_build_loop_pushes_build_account_fk` FOREIGN KEY (`build_id`,`account_id`) REFERENCES `story_builds`(`id`,`account_id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_build_loop_pushes_step` ON `story_build_loop_pushes` (`build_id`,`round`,`step`,`target_kind`,`target_id`,`attempt`);
--> statement-breakpoint
CREATE INDEX `story_build_loop_pushes_account_idx` ON `story_build_loop_pushes` (`account_id`,`build_id`);
--> statement-breakpoint
-- ONE ROW PER CODE-REVIEW RUN (per round, target and provider): the same columns + JSON as claude_reviews.
CREATE TABLE `story_build_reviews` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `build_id` integer NOT NULL,
  `round` integer NOT NULL,
  `target_kind` text NOT NULL,
  `target_id` integer NOT NULL,
  `repo_id` integer NOT NULL,
  `branch` text NOT NULL,
  `base_sha` text NOT NULL,
  `head_sha` text NOT NULL,
  `provider` text,
  `model` text,
  `effort` text,
  `pair_role` text,
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
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `completed_at` integer,
  CONSTRAINT `story_build_reviews_build_account_fk` FOREIGN KEY (`build_id`,`account_id`) REFERENCES `story_builds`(`id`,`account_id`) ON DELETE cascade,
  CONSTRAINT `story_build_reviews_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_build_reviews_run` ON `story_build_reviews` (`build_id`,`round`,`target_kind`,`target_id`,`provider`);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_build_reviews_id_account` ON `story_build_reviews` (`id`,`account_id`);
--> statement-breakpoint
CREATE INDEX `story_build_reviews_account_idx` ON `story_build_reviews` (`account_id`,`build_id`,`round`);
--> statement-breakpoint
CREATE TABLE `story_build_review_findings` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `review_id` integer NOT NULL,
  `build_id` integer NOT NULL,
  `round` integer NOT NULL,
  `severity` text NOT NULL,
  `path` text NOT NULL,
  `line` integer,
  `side` text NOT NULL DEFAULT 'RIGHT',
  `title` text NOT NULL,
  `body` text NOT NULL,
  `suggestion` text,
  `diff_hunk` text,
  `anchored` integer NOT NULL DEFAULT 0,
  `file_in_diff` integer NOT NULL DEFAULT 0,
  `prior_finding_id` integer,
  `lens` text,
  `merged_into` integer,
  `ref` text,
  `response` text,
  `response_text` text,
  `response_round` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT `story_build_review_findings_review_account_fk` FOREIGN KEY (`review_id`,`account_id`) REFERENCES `story_build_reviews`(`id`,`account_id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `story_build_review_findings_review_idx` ON `story_build_review_findings` (`review_id`);
--> statement-breakpoint
CREATE INDEX `story_build_review_findings_account_idx` ON `story_build_review_findings` (`account_id`,`build_id`,`round`);
--> statement-breakpoint
-- ONE STORY CHECK PER ROUND, across every target (the ticket review's assessment, build-scoped).
CREATE TABLE `story_build_story_checks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `build_id` integer NOT NULL,
  `round` integer NOT NULL,
  `status` text NOT NULL,
  `provider` text,
  `model` text,
  `assessment` text,
  `members` text,
  `claims` text,
  `claim_verdicts` text,
  `failure_reason` text,
  `cost_usd` real,
  `input_tokens` integer,
  `output_tokens` integer,
  `num_turns` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `completed_at` integer,
  CONSTRAINT `story_build_story_checks_build_account_fk` FOREIGN KEY (`build_id`,`account_id`) REFERENCES `story_builds`(`id`,`account_id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_build_story_checks_round` ON `story_build_story_checks` (`build_id`,`round`);
--> statement-breakpoint
-- The build agent's per-criterion answers (the fix pass), keyed by the round they answered.
CREATE TABLE `story_build_ac_responses` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `build_id` integer NOT NULL,
  `round` integer NOT NULL,
  `ref` text NOT NULL,
  `response` text NOT NULL,
  `text` text,
  CONSTRAINT `story_build_ac_responses_build_account_fk` FOREIGN KEY (`build_id`,`account_id`) REFERENCES `story_builds`(`id`,`account_id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_build_ac_responses_ref` ON `story_build_ac_responses` (`build_id`,`round`,`ref`);
