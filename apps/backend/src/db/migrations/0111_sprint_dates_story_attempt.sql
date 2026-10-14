-- ACTIVITY → THIS SPRINT: the sprint's own DATES + the story pass's last ATTEMPT (2026-10-14;
-- docs/TRACKERS.md § The sprint list read, docs/CLAUDE-REVIEW.md § Sprint story). The Postgres twin is
-- migrations-pg/0098_sprint_dates_story_attempt.sql.
--
--   sprint_reads.sprint_starts_at / sprint_ends_at  the current sprint's dates as the TRACKER gave them
--     (Jira sprint startDate/endDate, Linear cycle startsAt/endsAt, GitHub milestone dueOn — end only),
--     written by every successful read. NULL = none given.
--   sprint_reads.story_attempt_at / _hash / _error  the sprint story pass's last attempt that called
--     Claude: when, for which input hash, and the failure code when it stored nothing (NULL = stored).
--     A failure for today's input hash is not retried until the hash moves.
ALTER TABLE `sprint_reads` ADD `sprint_starts_at` integer;
--> statement-breakpoint
ALTER TABLE `sprint_reads` ADD `sprint_ends_at` integer;
--> statement-breakpoint
ALTER TABLE `sprint_reads` ADD `story_attempt_at` integer;
--> statement-breakpoint
ALTER TABLE `sprint_reads` ADD `story_attempt_hash` text;
--> statement-breakpoint
ALTER TABLE `sprint_reads` ADD `story_attempt_error` text;
