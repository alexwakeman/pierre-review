-- REVIEW-REQUEST HISTORY (CORE, free, no AI) — for Chronology's "asked to first look".
--
-- `review_requests` holds only OUTSTANDING requests, and GitHub removes one the moment the person
-- reviews — so for a merged PR we could not say whether a person or a team was asked, or how long
-- it was from the request to anyone looking. This table keeps every ReviewRequestedEvent and
-- ReviewRequestRemovedEvent from the PR's timeline (the first 25 per PR).
--
-- A PR CHILD with no account_id (the review_requests precedent): deleted by deletePrSubtree AND
-- deleteRepo, erased through the repo loop. Immutable: upserted DO NOTHING on (pr_id, node id).
--
-- `pull_requests.review_requests_synced_at` marks a PR whose history we actually RECEIVED. NULL is
-- "not known", which Chronology must not read as "never requested"; it is also the one-time
-- backfill's worklist (sync/backfill-review-requests.ts). The GraphQL selection that feeds this was
-- measured at 0 extra points per page (15 → 15, rateLimit dryRun, pullRequests(first: 25)).
-- The Postgres twin is migrations-pg/0053_review_request_events.sql.
CREATE TABLE `review_request_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pr_id` integer NOT NULL,
	`github_node_id` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`reviewer_kind` text NOT NULL,
	`reviewer_user_id` integer,
	`team_slug` text,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_request_events_pr_node` ON `review_request_events` (`pr_id`,`github_node_id`);
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `review_requests_synced_at` integer;
