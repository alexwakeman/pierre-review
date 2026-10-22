-- @pierre/pro plugin migration (SQLite / local mode). Discovered by FILENAME SORT, no journal, no
-- statement-breakpoint markers (the plugin migrator execs the file as one blob). Postgres twin:
-- migrations-pg/0037_auto_review_to_core.sql.
--
-- AUTO CLAUDE REVIEW MOVED TO CORE. Claude Review is core now (free, local-only), and its
-- per-workspace switch moved to core `workspaces.auto_review_enabled` / `auto_review_enabled_at`
-- (core migration sqlite 0074 / pg 0061). This copies every workspace's existing value across ONCE.
--
-- ⚠ THE COPY LIVES HERE, NOT IN CORE: only the plugin knows `pro_workspace_settings` exists, and a
-- core statement naming it would fail on every install that never had the plugin.
--
-- It copies only a switch that was ON, and only onto a workspace whose core switch was never set —
-- a value written through the new core route always wins. The plugin columns stay DORMANT (the
-- 0031 precedent): never read or written again, still erased with the row.
UPDATE workspaces
SET
  auto_review_enabled = 1,
  auto_review_enabled_at = (
    SELECT p.auto_review_enabled_at
    FROM pro_workspace_settings p
    WHERE p.workspace_id = workspaces.id AND p.account_id = workspaces.account_id
  )
WHERE auto_review_enabled IS NULL
  AND EXISTS (
    SELECT 1
    FROM pro_workspace_settings p
    WHERE p.workspace_id = workspaces.id
      AND p.account_id = workspaces.account_id
      AND p.auto_review_enabled = 1
      AND p.auto_review_enabled_at IS NOT NULL
  );
