-- Auto-merge intents ("arm it and walk away"), SQLite / local mode.
--
-- One row per (account, PR) recording a STANDING INTENT to merge once the blockers clear.
-- This is Pierre-side, not GitHub's native auto-merge, so it works on repos that don't enable
-- it and can offer a rebase-from-trunk step GitHub can't.
--
-- The safety property is `expected_head_oid`: arming is consent to merge THAT code. A new push
-- moves the head, the watcher sees the mismatch and disarms ('disarmed_head_moved') rather than
-- merging commits nobody looked at. `expires_at` is the second backstop, so an intent that never
-- becomes mergeable dies instead of lingering for weeks.
--
-- FKs CASCADE (unlike the rest of the core schema, which has none) so a repo/PR delete and an
-- account erasure clean this up without touching the intricate hand-ordered delete in
-- `deleteRepo`. The Postgres twin is migrations-pg/0025_auto_merge_requests.sql.
CREATE TABLE IF NOT EXISTS `auto_merge_requests` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `pr_id` integer NOT NULL REFERENCES `pull_requests`(`id`) ON DELETE cascade,
  `merge_method` text NOT NULL,
  `update_strategy` text NOT NULL,
  `expected_head_oid` text NOT NULL,
  `state` text NOT NULL,
  `armed_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `last_checked_at` integer,
  `last_reason` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
-- One armed request per PR per tenant — the upsert conflict target. Re-arming OVERWRITES.
CREATE UNIQUE INDEX IF NOT EXISTS `amr_account_pr` ON `auto_merge_requests` (`account_id`,`pr_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `amr_account_idx` ON `auto_merge_requests` (`account_id`);
--> statement-breakpoint
-- The watcher's scan: "every still-armed row".
CREATE INDEX IF NOT EXISTS `amr_state_idx` ON `auto_merge_requests` (`state`);
