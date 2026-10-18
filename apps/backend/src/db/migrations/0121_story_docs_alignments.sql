-- CHECK A STORY AGAINST THE DOCS (2026-10-18; docs/REFERENCE-DOCS.md § Check a story against the docs).
-- CORE, free, LOCAL ONLY (agentic). The Postgres twin is migrations-pg/0108_story_docs_alignments.sql.
--
--   story_docs_alignments   NEW. ONE row per RUN (a click): the story's hashes at queue time, the Haiku
--                           shortlist, the Sonnet result (only on success), the error, cost and tokens.
--                           A re-run is a NEW row, so the last good result is never overwritten.
-- Tenancy: the named COMPOSITE FK onto workspaces (id, account_id), ON DELETE cascade — a deleted
-- workspace takes its runs with it (their links name THAT workspace's library; never re-homed).
-- No unique index (one row per run), so no ON CONFLICT target to keep in step.
CREATE TABLE IF NOT EXISTS `story_docs_alignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ident` text NOT NULL,
	`ticket_key` text,
	`status` text NOT NULL,
	`fingerprint` text NOT NULL,
	`story_hash` text NOT NULL,
	`criteria_hash` text NOT NULL,
	`library_hash` text NOT NULL,
	`version` integer NOT NULL,
	`criteria_source` text NOT NULL,
	`criteria_json` text,
	`shortlist_json` text,
	`result_json` text,
	`error` text,
	`shortlist_model` text,
	`model` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_docs_alignments_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_docs_alignments_subject_idx` ON `story_docs_alignments` (`account_id`,`workspace_id`,`ident`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_docs_alignments_account_created` ON `story_docs_alignments` (`account_id`,`created_at`);
