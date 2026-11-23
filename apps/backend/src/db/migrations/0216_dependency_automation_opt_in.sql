-- DEPENDENCY AUTOMATION BECOMES OPT-IN (2026-11-22; docs/MERGE-CI-TRUNK.md § Dependency automation).
-- CORE. The product owner's decision reverses 0193: approve, merge, resolve conflicts and fix with AI
-- for Dependabot / Renovate pull requests are now OFF until switched on. From now on NULL reads OFF
-- (`dependencySwitchOn` is `=== true`; the merge sweep's roster reads `= 1`).
--
-- Existing data: 0193 set every NULL to 1 without anyone choosing it, so a 1 is reset to NULL (off)
-- UNLESS the workspace's settings history shows someone saved the dependency settings since then
-- (`workspace_setting_events` kinds 'dependency_automation' / 'dependency_auto_merge', written only
-- on a real change). A workspace someone configured keeps exactly what it has; elsewhere a stored 0
-- also becomes NULL, which reads the same (off).
UPDATE `workspaces` SET `dependency_auto_merge` = NULL, `dependency_auto_approve` = NULL,
  `dependency_auto_resolve` = NULL, `dependency_auto_fix` = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM `workspace_setting_events` e
  WHERE e.`workspace_id` = `workspaces`.`id` AND e.`account_id` = `workspaces`.`account_id`
    AND e.`kind` IN ('dependency_automation', 'dependency_auto_merge')
);
