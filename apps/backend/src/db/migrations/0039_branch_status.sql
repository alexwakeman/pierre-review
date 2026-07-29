-- Default-branch status ("is trunk green?"), SQLite / local mode.
--
-- Everything else in this app is PR-shaped, so the one thing that invalidates EVERY open PR's
-- CI at once — a broken default branch — had nowhere to live. Two additive pieces:
--
--  1. Four nullable columns on `repos`: a snapshot of the default branch head. Kept SEPARATE
--     from the existing `default_branch` column (written by the activity sync from GraphQL
--     defaultBranchRef.name for the maintainer inference) so the two syncs can't silently
--     clobber each other's freshness expectations.
--  2. `branch_commits`: the recent commits ON that branch with their observed CI state. This
--     is NOT derivable from the existing `commits` table, which is PR-scoped — a squash-merged
--     PR never appears there under its trunk SHA.
--
-- `branch_commits` FKs CASCADE so a repo delete / account erasure cleans up automatically.
-- Postgres twin: migrations-pg/0026_branch_status.sql.
ALTER TABLE `repos` ADD `default_branch_name` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD `default_branch_head_sha` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD `default_branch_ci_status` text;
--> statement-breakpoint
ALTER TABLE `repos` ADD `default_branch_updated_at` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `branch_commits` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `repo_id` integer NOT NULL REFERENCES `repos`(`id`) ON DELETE cascade,
  `sha` text NOT NULL,
  `message_headline` text NOT NULL,
  `author_user_id` integer REFERENCES `users`(`id`),
  `author_name` text,
  `author_avatar_url` text,
  `committed_at` integer NOT NULL,
  `ci_status` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
-- Idempotent upsert target — a re-sync of the same window updates CI state in place.
CREATE UNIQUE INDEX IF NOT EXISTS `bc_account_repo_sha` ON `branch_commits` (`account_id`,`repo_id`,`sha`);
--> statement-breakpoint
-- The read: one repo's window, newest first.
CREATE INDEX IF NOT EXISTS `bc_account_repo_time` ON `branch_commits` (`account_id`,`repo_id`,`committed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bc_account_idx` ON `branch_commits` (`account_id`);
