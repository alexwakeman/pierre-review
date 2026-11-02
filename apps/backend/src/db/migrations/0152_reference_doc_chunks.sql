-- FULL-TEXT SEARCH OVER THE REFERENCE LIBRARY (2026-11-01; docs/DOCS-RAG.md, docs/REFERENCE-DOCS.md
-- § Retrieval). CORE, local only. Additive.
--
--   reference_doc_chunks       NEW: a built document's section text cut into passages of ≤ 220 words,
--                              each prefixed with "Document › trail › section" and the section's
--                              one-line summary. Rewritten whole by every build (reference-docs/chunks.ts);
--                              DERIVED from the files on disk, so a missing row is rebuilt at boot.
--                              Composite FKs onto the document and the workspace; cascades.
--   reference_doc_chunks_fts   NEW FTS5 index over the chunks' text (external content, porter + unicode61).
--                              ⚠ Drizzle cannot declare a virtual table or a trigger: they live HERE only.
--                              The three triggers keep it in step on every insert, update and delete —
--                              including the FK cascades from a deleted document, workspace or account.
CREATE TABLE `reference_doc_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`doc_id` integer NOT NULL,
	`built_at` integer NOT NULL,
	`section_path` text NOT NULL,
	`anchor` text,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `reference_doc_chunks_doc_account_fk` FOREIGN KEY (`doc_id`,`account_id`) REFERENCES `reference_docs`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `reference_doc_chunks_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reference_doc_chunks_scope` ON `reference_doc_chunks` (`account_id`,`workspace_id`,`doc_id`);
--> statement-breakpoint
CREATE INDEX `reference_doc_chunks_doc` ON `reference_doc_chunks` (`doc_id`,`account_id`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `reference_doc_chunks_fts` USING fts5(`text`, content='reference_doc_chunks', content_rowid='id', tokenize='porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `reference_doc_chunks_fts_ai` AFTER INSERT ON `reference_doc_chunks` BEGIN
	INSERT INTO `reference_doc_chunks_fts`(rowid, `text`) VALUES (new.`id`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `reference_doc_chunks_fts_ad` AFTER DELETE ON `reference_doc_chunks` BEGIN
	INSERT INTO `reference_doc_chunks_fts`(`reference_doc_chunks_fts`, rowid, `text`) VALUES ('delete', old.`id`, old.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `reference_doc_chunks_fts_au` AFTER UPDATE ON `reference_doc_chunks` BEGIN
	INSERT INTO `reference_doc_chunks_fts`(`reference_doc_chunks_fts`, rowid, `text`) VALUES ('delete', old.`id`, old.`text`);
	INSERT INTO `reference_doc_chunks_fts`(rowid, `text`) VALUES (new.`id`, new.`text`);
END;
