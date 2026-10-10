-- TRACKER TICKET DATES (docs/TRACKERS.md § Created and resolved dates; Reports → Stories → Story
-- health). The Postgres twin is migrations-pg/0085_tracker_ticket_dates.sql.
--
-- The ticket's OWN created / resolved instants as its tracker gave them (Jira `created` /
-- `resolutiondate`, GitHub Issues `createdAt` / `closedAt`, Linear `createdAt` / `completedAt`).
-- Additive and nullable: a row read before this migration carries NULL until its next read
-- (tracker/dates-backfill.ts nudges the merged ones, a few at a time). Neither column moves
-- `changed_at` — they are not story text.
ALTER TABLE `tracker_tickets` ADD `issue_created_at` integer;
--> statement-breakpoint
ALTER TABLE `tracker_tickets` ADD `issue_resolved_at` integer;
