-- REPORTS → STORIES / THIS SPRINT: the three specific story issues and sections by status
-- (docs/TRACKERS.md § Blocking links, § The status order; docs/CLAUDE-REVIEW.md § Story issues). The
-- Postgres twin is migrations-pg/0090_sprint_statuses_and_blockers.sql. Additive and nullable.
--
--   • `blocked_by_json` (tracker_tickets + sprint_tickets): the tracker LINKS this ticket waits on
--     (Jira "is blocked by" / "depends on" issuelinks, Linear "blocks" relations), each with the linked
--     issue's key, title and status — shared `TicketLinkBlocker[]`. Read in the SAME issue read as the
--     ticket. NULL = never read (a row read before this column, or GitHub Issues, which has no links);
--     [] = read, none.
--   • `status_id` (tracker_tickets + sprint_tickets): the tracker's own status id (Jira `status.id`,
--     Linear state id), so a board's column order (status ids) maps onto the tickets.
--   • `sprint_reads.status_order_json`: the AUTOMATIC status order the sprint read found (shared
--     `SprintStatusAutoOrder`); NULL = not readable (the category fallback applies).
--   • `workspaces.sprint_statuses`: the workspace's OVERRIDE (shared `SprintStatusSettings`,
--     overrides only); NULL = automatic order and automatic "code delivered from".
ALTER TABLE `tracker_tickets` ADD `blocked_by_json` text;
--> statement-breakpoint
ALTER TABLE `tracker_tickets` ADD `status_id` text;
--> statement-breakpoint
ALTER TABLE `sprint_tickets` ADD `blocked_by_json` text;
--> statement-breakpoint
ALTER TABLE `sprint_tickets` ADD `status_id` text;
--> statement-breakpoint
ALTER TABLE `sprint_reads` ADD `status_order_json` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `sprint_statuses` text;
