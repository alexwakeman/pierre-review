-- REVIEW A LOCAL BRANCH (2026-11-19; docs/CLAUDE-REVIEW.md § Reviewing a local branch). CORE, additive.
-- `ensemble mcp` / `ensemble review` ask the running Ensemble to review the branch the reader works on, before
-- anything is pushed: the client sends a git bundle, the server pins it in its clone cache
-- (refs/pierre/local/local-review/<id>/head) and runs the branch review halves (a Claude + Codex pair is ONE
-- review) plus the story check when a ticket resolves. ONE ROW PER RUN; the findings in their own table. No
-- claude_reviews row, no ticket_reviews row, nothing posted.
--
-- kind:   'review' (code review, + the story check with a ticket) | 'story' (the story check only)
-- status: 'running' | 'succeeded' | 'failed' | 'cancelled'
CREATE TABLE `local_reviews` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `repo_id` integer NOT NULL,
  `workspace_id` integer NOT NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `branch` text NOT NULL,
  `base_ref` text,
  `base_sha` text NOT NULL,
  `head_sha` text NOT NULL,
  `local_ref` text,
  `include_uncommitted` integer DEFAULT 0 NOT NULL,
  `uncommitted_changes` integer DEFAULT 0 NOT NULL,
  `subjects` text,
  `provider_choice` text,
  `effort_choice` text,
  -- The code review: one entry per provider half ({provider, model, effort, status, failureReason, pairRole,
  -- followUp}), the consolidated summary / verdict, the pair's consolidation record.
  `reviewers` text,
  `summary` text,
  `verdict` text,
  `pair_consolidation` text,
  -- The story check (shared review-loop/story-check.ts): the ticket, why there is none, its assessment, the
  -- agent's criterion notes shown and the checker's verdicts on its "not applicable" ones.
  `ticket_key` text,
  `ticket_ident` text,
  `ticket_title` text,
  `ticket_url` text,
  `ticket_note` text,
  `story_status` text,
  `story_provider` text,
  `story_model` text,
  `story_failure` text,
  `assessment` text,
  `claims` text,
  `claim_verdicts` text,
  -- The answers the start carried (to the branch's previous run), as used.
  `answers` text,
  `prior_review_id` integer,
  `failure_reason` text,
  `cost_usd` real,
  `input_tokens` integer,
  `output_tokens` integer,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_reviews_id_account` ON `local_reviews` (`id`,`account_id`);
--> statement-breakpoint
CREATE INDEX `local_reviews_branch_idx` ON `local_reviews` (`account_id`,`repo_id`,`branch`,`id`);
--> statement-breakpoint
-- ONE RUN IN FLIGHT PER (repository, branch): the start's claim is this index (a second start reads the running id).
CREATE UNIQUE INDEX `local_reviews_one_running` ON `local_reviews` (`account_id`,`repo_id`,`branch`) WHERE `status` = 'running';
--> statement-breakpoint
-- The findings of one run (`half`: 0 the first provider half, 1 the second), plus the agent's later answer.
CREATE TABLE `local_review_findings` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `local_review_id` integer NOT NULL,
  `half` integer DEFAULT 0 NOT NULL,
  `provider` text,
  `severity` text NOT NULL,
  `path` text NOT NULL,
  `line` integer,
  `side` text DEFAULT 'RIGHT' NOT NULL,
  `title` text NOT NULL,
  `body` text NOT NULL,
  `suggestion` text,
  `diff_hunk` text,
  `anchored` integer DEFAULT 0 NOT NULL,
  `file_in_diff` integer DEFAULT 0 NOT NULL,
  `prior_finding_id` integer,
  `lens` text,
  `merged_into` integer,
  `response` text,
  `response_text` text,
  `response_review_id` integer,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `local_review_findings_review_account_fk` FOREIGN KEY (`local_review_id`,`account_id`) REFERENCES `local_reviews`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `local_review_findings_review_idx` ON `local_review_findings` (`account_id`,`local_review_id`);
