-- SEQUENCE DIAGRAMS (2026-10-16; docs/CLAUDE-REVIEW.md § Sequence diagrams). CORE, free, LOCAL ONLY
-- (agentic) — the table exists in both modes, as every agentic table does.
--
--   sequence_diagrams  NEW. ONE row per (account, kind, subject, fingerprint): kind 'pr' (subject =
--                      the PR id, pr_id set) or 'story' (subject = the tracker ident, pr_id NULL). A
--                      Redraw at the same fingerprint rewrites the row; a new head or member set is a
--                      new row. Validated Mermaid source only. No FK on pr_id (the sonar_snapshots
--                      precedent): both delete paths and the erasure take it.
-- The Postgres twin is migrations-pg/0102_sequence_diagrams.sql.
CREATE TABLE IF NOT EXISTS `sequence_diagrams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`pr_id` integer,
	`ticket_key` text,
	`fingerprint` text NOT NULL,
	`head_sha` text,
	`members` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`title` text,
	`caption` text,
	`diagram_type` text,
	`source` text,
	`refusal` text,
	`error` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`num_turns` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sequence_diagrams_subject_fp` ON `sequence_diagrams` (`account_id`,`kind`,`subject`,`fingerprint`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sequence_diagrams_account_created` ON `sequence_diagrams` (`account_id`,`created_at`);
