-- DEPENDENCY AUTOMATION FOR TEAMS (docs/MERGE-CI-TRUNK.md § Dependency automation). Additive; no data to move.
--
--   workspaces.dependency_auto_fix                     "Fix dependency PRs with AI"; NULL/false = off (the default).
--   dependency_automation_actions.teammate_login       a 'skipped' row's teammate (their `limn/deps` line holds the head).
--   dependency_automation_actions.teammate_handled     1 = their line said they finished an action here; else handling now.
--   The `action` ('ai_fix', 'arm_merge', 'merge_landed') and `state` ('skipped') columns are plain
--   text with no CHECK, so their new values need no DDL.
ALTER TABLE `workspaces` ADD `dependency_auto_fix` integer;
--> statement-breakpoint
ALTER TABLE `dependency_automation_actions` ADD `teammate_login` text;
--> statement-breakpoint
ALTER TABLE `dependency_automation_actions` ADD `teammate_handled` integer;
