-- REFERENCE DOCS (2026-10-16; docs/REFERENCE-DOCS.md). CORE, free, LOCAL ONLY (agentic).
--
--   workspaces.docs_in_review     NEW column. May Claude Review read this workspace's reference
--                                 library? NULL/false = OFF (the default); no default, so no insert
--                                 has to name it.
--   reference_docs                NEW. ONE row per document in a workspace's library: metadata, the
--                                 latest build's status/progress, and the last successful build's
--                                 summary, topics and section list. The text itself is markdown
--                                 files on disk; `built_at` non-null = a built version is there.
--   reference_doc_chat_messages   NEW. The docs chat, one row per question and per answer.
-- Both tables take their workspace through the named COMPOSITE FK onto workspaces (id, account_id).
-- The Postgres twin is migrations-pg/0103_reference_docs.sql.
ALTER TABLE `workspaces` ADD `docs_in_review` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reference_docs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_name` text NOT NULL,
	`source_url` text,
	`byte_size` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`stage` text,
	`error` text,
	`section_count` integer DEFAULT 0 NOT NULL,
	`sections` text,
	`summary` text,
	`topics` text,
	`page_count` integer,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`build_started_at` integer,
	`built_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `reference_docs_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `reference_docs_workspace_slug` ON `reference_docs` (`account_id`,`workspace_id`,`slug`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reference_doc_chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`citations` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `reference_doc_chat_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reference_doc_chat_conversation` ON `reference_doc_chat_messages` (`account_id`,`workspace_id`,`conversation_id`);
