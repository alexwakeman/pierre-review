-- ADOPT THE AGENTIC TABLES INTO CORE (Claude Review memory + AI Fix), and give each workspace its
-- auto-review switch. Claude Review, review memory and AI Fix moved from the private plugin into
-- core (free, local-only); their two tables move with them. The Postgres twin is
-- migrations-pg/0061_adopt_agentic_tables.sql.
--
-- ⚠ ADOPTED IN PLACE, NEVER RENAMED. On an install where the plugin already created them
-- (plugin migrations 0001 / 0002 / 0003 / 0024) every CREATE below is a no-op and the rows stay as
-- they are. On a fresh or plugin-less install this creates them. The DDL is the plugin's FINAL
-- shape, minus the eight dormant `resolved_*` / `resolve_error` columns of plugin 0003 (AI Fix's
-- removed rebase artifact): nothing declares or reads them, and an adopted table that still carries
-- them reads identically. Same types, same defaults, same index names, and NO foreign keys — SQLite
-- cannot add one to an existing table without a rebuild, so a fresh and an adopted install would
-- otherwise differ. Tenancy is query-layer (every read filters account_id) plus verify:isolation;
-- no id in either table arrives in a request body.
--
-- ⚠ THE PLUGIN'S OWN COPIES OF THIS DDL WERE STRIPPED IN THE SAME CHANGE (plugin 0001's
-- review_learnings half, 0002's ai_fixes half, 0003 and 0024 entirely). Core migrations run BEFORE
-- the plugin binds, so on a fresh SQLite install core creates the full ai_fixes first — and the
-- plugin's bare `ALTER TABLE ai_fixes ADD COLUMN` would throw "duplicate column", which drops the
-- WHOLE plugin to OSS mode silently.
--
-- Known gap: an install whose plugin stopped before 0024 (pre-apiVersion 19) keeps an ai_fixes
-- without comment_targets/comment_verdicts — SQLite has no ADD COLUMN IF NOT EXISTS. No such
-- install is known; the pg twin adds them idempotently.
CREATE TABLE IF NOT EXISTS `review_learnings` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`source_review_id` integer NOT NULL,
	`finding_id` integer,
	`head_sha` text NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`dir_path` text,
	`ext` text,
	`category` text,
	`claude_verdict` text,
	`user_verdict` text,
	`claude_title` text,
	`claude_text` text,
	`user_text` text,
	`posted_comment_kind` text,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `rl_account_dedupe` ON `review_learnings` (`account_id`,`dedupe_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rl_account_repo_category` ON `review_learnings` (`account_id`,`repo_id`,`category`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rl_account_repo_dir` ON `review_learnings` (`account_id`,`repo_id`,`dir_path`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rl_account_source_review` ON `review_learnings` (`account_id`,`source_review_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rl_account_repo_created` ON `review_learnings` (`account_id`,`repo_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_fixes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`source_review_id` integer,
	`base_sha` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`seed` text NOT NULL,
	`prompt` text,
	`summary` text,
	`commit_message` text,
	`patch` text,
	`files_changed` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`error` text,
	`pushed_branch` text,
	`pushed_pr_number` integer,
	`pushed_pr_url` text,
	`pushed_at` integer,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	`finished_at` integer,
	`comment_targets` text,
	`comment_verdicts` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `af_account_pr_created` ON `ai_fixes` (`account_id`,`pr_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `af_account_status` ON `ai_fixes` (`account_id`,`status`);
--> statement-breakpoint
-- AUTO CLAUDE REVIEW, PER WORKSPACE (moved off the plugin's pro_workspace_settings, plugin 0036).
-- NULL/0 = off. `auto_review_enabled_at` is when it was last switched ON: the sweeper reviews only
-- PRs OPENED at or after it. The plugin's migration 0037 copies existing values across — a core
-- statement naming pro_workspace_settings would fail on every install that never had the plugin.
ALTER TABLE `workspaces` ADD `auto_review_enabled` integer;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `auto_review_enabled_at` integer;
