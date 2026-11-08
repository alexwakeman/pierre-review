-- IMPLEMENT, PLAN FIRST (docs/STORY-BUILD.md § Plan first; docs/SANDBOX.md § The plan and its checks). CORE,
-- additive. A story session opens with a planning turn; the agent's plan is checked on the host and stored
-- as a REVISION; the reader settles each point of contention and approves; the build follows the approved
-- stack of pull requests.
--
--   story_builds.with_docs         "Implement with docs" was chosen (a read-only copy of part of the
--                                  reference library goes into the sandbox).
--   story_builds.approved_plan_id  the revision the reader approved (story_build_plans.id). NO FK: readers
--                                  re-scope it by (build_id, account_id), like stacked_on_pr_id.
--   story_builds.approved_at       when.
--
--   story_build_plans   NEW. ONE row per plan revision (the decision log lives here):
--     plan_json        the VERIFIED revision (shared BuildPlanRevision, minus revision/createdAt);
--     raw_sha          sha256 of the raw block (an identical resubmission makes no new revision);
--     decisions_json   { [contentionId]: { decision, fingerprint, at } } — this revision's answers
--                      (carried forward from the previous revision by id + fingerprint);
--     replies_json     [{ contentionId, text, at }] sent FROM this revision.
--   story_build_prs     NEW. ONE row per PLANNED pull request, created at Approve. status: shared
--                       StoryBuildPrStatus (planned · ready · empty · failed · pushed). The patch and the
--                       trees are computed on the HOST from verified commits (docs/STORY-BUILD.md § Stacks).
--
-- Tenancy: named COMPOSITE FKs onto story_builds (id, account_id), repos (id, account_id) and
-- story_build_plans (id, account_id), all ON DELETE cascade. deleteRepo still deletes a repository's
-- story_build_prs rows explicitly (no CASCADE reliance in core).
ALTER TABLE `story_builds` ADD `with_docs` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD `approved_plan_id` integer;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD `approved_at` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `story_build_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`build_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`source` text NOT NULL,
	`plan_json` text NOT NULL,
	`raw_sha` text NOT NULL,
	`decisions_json` text,
	`replies_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_build_plans_build_account_fk` FOREIGN KEY (`build_id`,`account_id`) REFERENCES `story_builds`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_build_plans_build_revision` ON `story_build_plans` (`build_id`,`revision`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_build_plans_id_account` ON `story_build_plans` (`id`,`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_build_plans_account_idx` ON `story_build_plans` (`account_id`,`build_id`,`revision`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `story_build_prs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`build_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`plan_id` integer NOT NULL,
	`pr_key` text NOT NULL,
	`position` integer NOT NULL,
	`stack_index` integer NOT NULL,
	`depends_on_json` text,
	`criteria_json` text,
	`title` text NOT NULL,
	`contains` text NOT NULL,
	`branch` text NOT NULL,
	`status` text NOT NULL,
	`tip_sha` text,
	`tree_sha` text,
	`patch` text,
	`patch_sha` text,
	`stat_json` text,
	`files_changed_json` text,
	`commit_message` text,
	`summary` text,
	`checks_json` text,
	`error` text,
	`pushed_branch` text,
	`pushed_pr_number` integer,
	`pushed_pr_url` text,
	`pushed_commit_sha` text,
	`pushed_at` integer,
	`pr_title` text,
	`pr_body` text,
	`push_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_build_prs_build_account_fk` FOREIGN KEY (`build_id`,`account_id`) REFERENCES `story_builds`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_build_prs_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_build_prs_plan_account_fk` FOREIGN KEY (`plan_id`,`account_id`) REFERENCES `story_build_plans`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_build_prs_build_key` ON `story_build_prs` (`build_id`,`pr_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_build_prs_id_account` ON `story_build_prs` (`id`,`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_build_prs_account_idx` ON `story_build_prs` (`account_id`,`build_id`,`position`);
