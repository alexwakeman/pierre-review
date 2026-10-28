-- TICKET COMMENTS (docs/TRACKERS.md § Ticket comments). The discussion under a tracker ticket, one row
-- per (account, provider, site, key, comment) — per TICKET, never per PR. The worker keeps the newest 20
-- per ticket from the issue read it already makes; bots are stored with `is_bot` and never shown.
CREATE TABLE `tracker_ticket_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`provider` text NOT NULL,
	`api_root` text NOT NULL,
	`issue_key` text NOT NULL,
	`comment_id` text NOT NULL,
	`author_name` text DEFAULT '' NOT NULL,
	`author_id` text,
	`is_bot` integer DEFAULT false NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracker_ticket_comments_ticket_comment` ON `tracker_ticket_comments` (`account_id`,`provider`,`api_root`,`issue_key`,`comment_id`);
