-- THE STORY CHECK'S STORED CLOCK (2026-11-09; docs/CLAUDE-REVIEW.md § The automatic story check's
-- clock). CORE, additive, no backfill.
--
--   pull_requests.head_seen_at   when Limn SAW the synced head move (an insert: the PR's opened_at).
--                                Never the commit's committedAt: an old commit pushed late would start
--                                the 2-minute grace window already expired. NULL = not known (a row
--                                synced before this migration) — never a change.
--   pull_requests.head_burst_at  when the PR's current BURST of pushes began: a head move less than the
--                                grace window (2 min) after the previous one keeps it; a later one
--                                restarts it (an insert: opened_at). One column holds only the newest
--                                push, so without it a PR pushed every minute could never reach the
--                                story check's 20-minute ceiling. NULL = not known.
--   tracker_tickets.linked_at    when this PR first joined the ticket (the row's FIRST insert only;
--                                never in the upsert's update set). NULL = an older row — never a change.
--   ticket_reviews.cause         why the automatic sweeper queued the run: 'first' | 'pushed' |
--                                'joined' | 'left' | 'merged' | 'story_edited'. NULL = a manual run or
--                                an older row ("not known").
ALTER TABLE `pull_requests` ADD COLUMN `head_seen_at` integer;
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD COLUMN `head_burst_at` integer;
--> statement-breakpoint
ALTER TABLE `tracker_tickets` ADD COLUMN `linked_at` integer;
--> statement-breakpoint
ALTER TABLE `ticket_reviews` ADD COLUMN `cause` text;
