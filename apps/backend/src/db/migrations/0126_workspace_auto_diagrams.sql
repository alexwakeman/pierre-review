-- AUTOMATIC DESIGN DIAGRAMS, PER WORKSPACE — `workspaces.auto_diagrams_enabled`. After every
-- succeeded Claude review (manual or auto), review/diagrams/trigger.ts may queue the PR's design
-- diagram and its tickets' story diagrams. This is that step's switch, edited in Settings beside
-- auto review and written by `setWorkspaceAutoReview` (review/claude-review/auto-settings.ts).
-- ⚠ DEFAULT TRUE (1) and NOT NULL: diagrams were drawn after every review before this column
-- existed, so every workspace, existing and new, keeps that until someone switches it off. Off
-- stops only the AUTOMATIC draw; the Draw / Redraw button still works.
ALTER TABLE `workspaces` ADD `auto_diagrams_enabled` integer DEFAULT 1 NOT NULL;
