-- REPORTS → THIS SPRINT: "Check against code" is STAGE-AWARE (docs/CLAUDE-REVIEW.md § Sprint
-- assessment). The Postgres twin is migrations-pg/0092_sprint_assessment_mode.sql. Additive, nullable.
--
--   • `sprint_assessments.mode`: 'plan' (a not-started / in-progress ticket: list the changes needed) or
--     'verify' (in review / done: check each criterion against the default branch), picked by the server
--     from the ticket's stage when the run starts and folded into its fingerprint. NULL on runs stored
--     before format 5 (they read as out of date anyway).
ALTER TABLE `sprint_assessments` ADD `mode` text;
