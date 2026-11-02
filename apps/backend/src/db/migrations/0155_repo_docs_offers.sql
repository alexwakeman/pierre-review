-- DOCS OFFERED FROM THE REPOSITORIES (2026-11-01; docs/REFERENCE-DOCS.md § Docs offered from your
-- repositories). CORE, additive, no backfill.
--
--   reference_doc_repo_offers   NEW: one row per (workspace, repository, folder) found to look like a docs
--                               collection. `state` = 'offered' (waiting for the reader), 'declined'
--                               ("Not now": never offered again) or 'added' (a document was queued;
--                               `doc_id` names it, kept after the document is removed so the folder is
--                               not offered again). Nothing is built from a row until the reader presses
--                               Add. Composite FKs onto the workspace and the repository; both cascade,
--                               and repos' delete clears it explicitly too.
--   repos.docs_offer_scanned_at NEW: when the repository's tree was last looked at for docs folders.
--                               NULL = never; looked at again after DOCS_OFFER_RESCAN_DAYS.
CREATE TABLE `reference_doc_repo_offers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`path` text NOT NULL,
	`doc_count` integer NOT NULL,
	`word_estimate` integer NOT NULL,
	`page_count` integer NOT NULL,
	`too_large` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'offered' NOT NULL,
	`doc_id` integer,
	`detected_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `reference_doc_repo_offers_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `reference_doc_repo_offers_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reference_doc_repo_offers_folder` ON `reference_doc_repo_offers` (`account_id`,`workspace_id`,`repo_id`,`path`);
--> statement-breakpoint
CREATE INDEX `reference_doc_repo_offers_scope` ON `reference_doc_repo_offers` (`account_id`,`workspace_id`,`state`);
--> statement-breakpoint
ALTER TABLE `repos` ADD `docs_offer_scanned_at` integer;
