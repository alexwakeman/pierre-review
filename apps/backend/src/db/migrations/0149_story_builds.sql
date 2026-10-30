-- "IMPLEMENT STORY" (2026-10-30; docs/STORY-BUILD.md). CORE, free, LOCAL ONLY (agentic).
--
--   story_builds        NEW. ONE row per SESSION (one ticket, one reader click): the frozen inputs (gap
--                       fold, candidates, the fenced prompt seed — never on the wire), the plan and its
--                       chat, the docs consideration and its decisions, what Accept froze, spend.
--   story_build_repos   NEW. ONE row per repository in a session: base (and the PR it stacks on), the
--                       branch, the captured patch and change report, "Run tests", the push.
--
-- Tenancy: the named COMPOSITE FK onto workspaces (id, account_id), ON DELETE cascade (the
-- story_docs_alignments precedent — a session belongs to the workspace it started in; never re-homed).
-- `story_build_repos` reaches its session through (build_id, account_id) → story_builds (id, account_id)
-- and its repository through (repo_id, account_id) → repos (id, account_id), both cascade, so deleteRepo
-- takes a repository's build rows with it. `stacked_on_pr_id` has NO FK (a PR subtree delete must not be
-- blocked, and SET NULL on a composite would null account_id): readers re-scope it.
--
-- ONE OPEN SESSION PER TICKET: the partial unique `story_builds_one_open` below (drizzle predicates are
-- inert, so it lives HERE only). Its status list is shared `STORY_BUILD_OPEN_STATUSES`.
-- The unique `(build_id, repo_id)` is the ON CONFLICT target for the repository rows.
CREATE TABLE IF NOT EXISTS `story_builds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ident` text NOT NULL,
	`ticket_key` text NOT NULL,
	`ticket_title` text,
	`status` text NOT NULL,
	`phase` text,
	`error` text,
	`provider` text,
	`model` text,
	`effort` text,
	`want_diagram` integer DEFAULT false NOT NULL,
	`want_docs` integer DEFAULT false NOT NULL,
	`story_hash` text,
	`criteria_source` text,
	`criteria_json` text,
	`coverage_json` text,
	`seed_json` text,
	`candidates_json` text,
	`plan_json` text,
	`plan_revision` integer DEFAULT 0 NOT NULL,
	`transcript_json` text,
	`design_json` text,
	`docs_status` text DEFAULT 'none' NOT NULL,
	`docs_json` text,
	`docs_decisions_json` text,
	`docs_error` text,
	`docs_cost_usd` real,
	`accepted_revision` integer,
	`accepted_docs_json` text,
	`plan_cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_builds_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_builds_id_account` ON `story_builds` (`id`,`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_builds_subject_idx` ON `story_builds` (`account_id`,`workspace_id`,`ident`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_builds_account_created` ON `story_builds` (`account_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_builds_one_open` ON `story_builds` (`account_id`,`workspace_id`,`ident`) WHERE `status` IN ('assessing','planning','plan_ready','building','ready');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `story_build_repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`build_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`ref` text NOT NULL,
	`build_order` integer DEFAULT 0 NOT NULL,
	`include` integer DEFAULT true NOT NULL,
	`status` text NOT NULL,
	`base_ref` text NOT NULL,
	`base_sha` text NOT NULL,
	`stacked_on_pr_id` integer,
	`branch` text,
	`worktree_path` text,
	`patch` text,
	`files_changed_json` text,
	`summary` text,
	`commit_message` text,
	`change_report_json` text,
	`checks_wanted_json` text,
	`checks_json` text,
	`pr_title` text,
	`pr_body` text,
	`pushed_branch` text,
	`pushed_pr_number` integer,
	`pushed_pr_url` text,
	`pushed_commit_sha` text,
	`pushed_at` integer,
	`push_error` text,
	`provider` text,
	`model` text,
	`effort` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_build_repos_build_account_fk` FOREIGN KEY (`build_id`,`account_id`) REFERENCES `story_builds`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_build_repos_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_build_repos_build_repo` ON `story_build_repos` (`build_id`,`repo_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_build_repos_account_idx` ON `story_build_repos` (`account_id`,`build_id`);
