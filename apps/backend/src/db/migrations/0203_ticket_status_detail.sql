-- RELEASES: THE TICKET DETAIL (2026-11-16; docs/RELEASES.md § Implementation → Tag list and ticket detail).
-- CORE, additive. The batched status read (tracker/ticket-status.ts) also keeps the ticket's type and
-- assignee, so the Releases tab can show them from the DB (never a tracker call on a view).
ALTER TABLE `tracker_ticket_status` ADD COLUMN `issue_type_name` text;
--> statement-breakpoint
ALTER TABLE `tracker_ticket_status` ADD COLUMN `assignee_name` text;
