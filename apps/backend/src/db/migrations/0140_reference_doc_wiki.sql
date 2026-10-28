-- WIKI SOURCES FOR THE REFERENCE LIBRARY (2026-10-28; docs/REFERENCE-DOCS.md § Wiki sources). CORE,
-- free, LOCAL ONLY (agentic). A Confluence page tree becomes ONE document; a refresh re-reads only the
-- changed pages and re-summarises only the changed sections. Self-contained and additive.
--
--   reference_docs.wiki_json            NEW, nullable JSON (ReferenceDocWikiState): the tree's root,
--                                       depth and refresh state. NULL for every other source.
--   reference_docs.summary_cache_json   NEW, nullable JSON (ReferenceDocSummaryCache): section hash →
--                                       summary, so an unchanged section is never summarised again.
--   reference_docs (id, account_id)     NEW unique index: the composite FK target below.
--   workspaces.docs_used_at             NEW, nullable: the library was last used — the refresh's
--                                       demand gate (7 days).
--   reference_doc_wiki_pages            NEW: one row per page of a wiki document (version, hash, last
--                                       fetch, last error). Composite FK onto the document; cascades.
--   workspace_wiki_credentials          NEW: a sealed wiki credential per (workspace, provider).
--                                       Composite FK onto the workspace; cascades.
-- Both new tables carry account_id and join accountScopedTables() (erased, exported without the token).
ALTER TABLE `reference_docs` ADD COLUMN `wiki_json` text;
--> statement-breakpoint
ALTER TABLE `reference_docs` ADD COLUMN `summary_cache_json` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD COLUMN `docs_used_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `reference_docs_id_account` ON `reference_docs` (`id`,`account_id`);
--> statement-breakpoint
CREATE TABLE `reference_doc_wiki_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`doc_id` integer NOT NULL,
	`page_id` text NOT NULL,
	`parent_page_id` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`version` integer,
	`last_edited_at` integer,
	`content_hash` text,
	`last_fetched_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `reference_doc_wiki_pages_doc_account_fk` FOREIGN KEY (`doc_id`,`account_id`) REFERENCES `reference_docs`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reference_doc_wiki_pages_doc_page` ON `reference_doc_wiki_pages` (`doc_id`,`page_id`);
--> statement-breakpoint
CREATE INDEX `reference_doc_wiki_pages_account_doc` ON `reference_doc_wiki_pages` (`account_id`,`doc_id`);
--> statement-breakpoint
CREATE TABLE `workspace_wiki_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`provider` text NOT NULL,
	`site_url` text,
	`auth_email` text,
	`auth_token` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_wiki_credentials_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_wiki_credentials_workspace_provider` ON `workspace_wiki_credentials` (`account_id`,`workspace_id`,`provider`);
