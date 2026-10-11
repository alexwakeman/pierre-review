-- REPORTS → THIS SPRINT: "the reader saved this ticket's repos" (docs/API.md § This sprint). The
-- Postgres twin is migrations-pg/0091_sprint_ticket_repos_saved.sql. Additive and nullable.
--
--   • `sprint_tickets.repos_saved_at`: when the reader last saved the ticket's candidate repos (PUT
--     /api/sprint-stories/repos), set even for an EMPTY set. NULL = never saved: the confident
--     suggestions are the accepted set by default. Pruned with the row (and the row's accepted repos).
ALTER TABLE `sprint_tickets` ADD `repos_saved_at` integer;
