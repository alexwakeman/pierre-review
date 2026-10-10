-- REPORTS → THIS SPRINT: which chips a workspace raises (the Postgres twin is
-- migrations-pg/0089_workspace_sprint_checks.sql). OVERRIDES ONLY (`SprintChecks`): NULL = every check
-- on for every issue type. A team with one persona switches "No persona" off; another limits a check
-- to its Story issue type.
ALTER TABLE `workspaces` ADD `sprint_checks` text;
