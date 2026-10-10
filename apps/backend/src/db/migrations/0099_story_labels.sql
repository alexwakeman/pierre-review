-- STORY LABELS (docs/CLAUDE-REVIEW.md § Story labels; Reports → Stories → Story health). The
-- Postgres twin is migrations-pg/0086_story_labels.sql.
--
--   story_labels   NEW. One row per (account, story ident, rubric version, hash of the text the
--                  labeller was sent): Haiku 5.5's answers to a FIXED rubric, per numbered criterion
--                  (`criteria_json`) and per story (`story_json`). A label is CURRENT only while its
--                  rubric version and text hash both match today's, so an edit or a rubric bump
--                  relabels and the old row stops counting. Written only by the local label run.
--
-- Tenancy: no request-body id references it (the ident is derived server-side), so a plain FK onto
-- `accounts`. Listed in `accountScopedTables()` and erased with the account.
CREATE TABLE IF NOT EXISTS `story_labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`ident` text NOT NULL,
	`text_hash` text NOT NULL,
	`rubric_version` integer NOT NULL,
	`criteria_json` text NOT NULL,
	`story_json` text NOT NULL,
	`criteria_count` integer NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_labels_identity_ux` ON `story_labels` (`account_id`,`ident`,`rubric_version`,`text_hash`);
