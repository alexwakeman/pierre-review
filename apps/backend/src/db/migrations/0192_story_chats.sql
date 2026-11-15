-- STORY CHAT (2026-11-13; docs/STORY-CHAT.md). CORE, additive.
--
--   story_chats       NEW: one row per chat about one story (account, workspace, ticket ident).
--   story_chat_turns  NEW: its questions and answers, in order. Limn's own record, never an import
--                     of the reader's agent sessions.
CREATE TABLE IF NOT EXISTS `story_chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`ticket_ident` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_chats_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_chats_id_account` ON `story_chats` (`id`,`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_chats_account_ws_ticket_idx` ON `story_chats` (`account_id`,`workspace_id`,`ticket_ident`,`updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `story_chat_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`question` text NOT NULL,
	`answer` text,
	`status` text NOT NULL,
	`error` text,
	`provider` text,
	`model` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_chat_turns_chat_account_fk` FOREIGN KEY (`chat_id`,`account_id`) REFERENCES `story_chats`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_chat_turns_chat_idx` ON `story_chat_turns` (`chat_id`,`id`);
