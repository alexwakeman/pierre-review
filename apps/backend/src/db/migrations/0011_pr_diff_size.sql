-- PR diff-size metadata (additive). Adds the GraphQL additions/deletions/
-- changedFiles totals and the per-file breakdown (files JSON) to pull_requests,
-- powering the PR-detail LOC summary label and the new "Changes" tab. This is
-- small metadata (not bulky user text), so it's stored in BOTH modes regardless
-- of lean storage. Existing rows get the 0 defaults / NULL files until the next
-- sync backfills real values.
ALTER TABLE `pull_requests` ADD `additions` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `deletions` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `changed_files` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `files` text;
