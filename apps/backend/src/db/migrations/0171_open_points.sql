-- OPEN POINTS (2026-11-06; docs/TRACKERS.md § Open points, docs/CLAUDE-REVIEW.md § Open points). CORE.
--
--   tracker_open_points_fields   NEW. Where an issue type's open points are read, per (account,
--                                workspace, tracker site, issue type): mode 'field' (field_id/name) or
--                                'none' (the description only). No row = 'auto'. No FKs, like
--                                pro_jira_ac_fields; erased with the account (erase-account.ts).
--   claude_reviews.open_points   NEW, nullable JSON (`ClaudeReviewOpenPoints`): the tickets' open
--                                points a PR review was given and the code it tied to each. NULL on
--                                every older row.
-- ⚠ Upserts on tracker_open_points_fields target (account_id, workspace_id, api_root, issue_type_id).
CREATE TABLE IF NOT EXISTS `tracker_open_points_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`api_root` text NOT NULL,
	`issue_type_id` text NOT NULL,
	`mode` text NOT NULL,
	`field_id` text,
	`field_name` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tracker_open_points_fields_account_ws_site_type` ON `tracker_open_points_fields` (`account_id`,`workspace_id`,`api_root`,`issue_type_id`);
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `open_points` text;
