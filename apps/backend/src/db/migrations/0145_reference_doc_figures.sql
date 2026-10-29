-- FIGURES AS TEXT + NOTION SOURCES (2026-10-28; docs/REFERENCE-DOCS.md § Figures, § Wiki sources →
-- Notion). CORE, free, LOCAL ONLY (agentic). Self-contained and additive. Notion needs no schema: its
-- token is a `workspace_wiki_credentials` row with provider 'notion' (0140).
--
--   reference_docs.figures_json          NEW, nullable JSON (ReferenceDocFigures): the latest build's
--                                        figures — described / outlined / kept / pending — and the one
--                                        sentence when they could not be described here.
--   reference_doc_figure_descriptions    NEW: the AI image-description CACHE, one row per (account,
--                                        image sha256), so an unchanged image is never described again.
-- The table carries account_id, joins accountScopedTables(), the erasure and the export.
ALTER TABLE `reference_docs` ADD COLUMN `figures_json` text;
--> statement-breakpoint
CREATE TABLE `reference_doc_figure_descriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`image_hash` text NOT NULL,
	`description` text NOT NULL,
	`provider` text,
	`model` text,
	`cost_usd` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reference_doc_figure_descriptions_account_hash` ON `reference_doc_figure_descriptions` (`account_id`,`image_hash`);
