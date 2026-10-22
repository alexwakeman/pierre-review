-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite
-- 0031_workspace_issue_tracker.sql, where the WHOLE rationale lives — why the tracker is a
-- workspace fact, why the backfill copies into EVERY workspace rather than only the Default (a
-- Default-only copy would silently drop ticket links for every other workspace), why the cadence's
-- account fallback is retired with NO cadence backfill, why "no cadence" is the product default and
-- no number is invented, and why NOT ONE COLUMN IS DROPPED in either dialect.
--
-- ⚠ A PLUGIN pg MIGRATION THAT FAILS IS DOWNGRADED TO A WARNING BY THE HOST'S RUNNER, which
-- silently drops the WHOLE plugin to OSS mode — so every statement here is written to be
-- idempotent and replay-safe (`IF NOT EXISTS` on each ADD COLUMN, an upsert for the backfill).
-- Mirrored BY EYE: this package has no schema-parity test.
--
-- The only intentional dialect divergence is the `updated_at` expression in the conflict clause:
-- sqlite writes `unixepoch()` into an integer column, pg writes `now()` into a timestamptz.

ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS issue_provider text;
ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS issue_base_url text;
ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS issue_project_keys text;
-- 'title' | 'title_branch'. NULL reads as 'title_branch' — today's behaviour — so no existing
-- workspace's ticket detection changes when this column appears.
ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS issue_match_scope text;

INSERT INTO pro_workspace_settings (
  account_id, workspace_id, issue_provider, issue_base_url, issue_project_keys
)
SELECT
  s.account_id,
  w.id,
  s.issue_provider,
  trim(s.issue_base_url),
  s.issue_project_keys
FROM pro_settings s
JOIN workspaces w ON w.account_id = s.account_id
WHERE s.issue_provider IS NOT NULL
  AND s.issue_base_url IS NOT NULL
  AND trim(s.issue_base_url) <> ''
ON CONFLICT (account_id, workspace_id) DO UPDATE SET
  issue_provider = excluded.issue_provider,
  issue_base_url = excluded.issue_base_url,
  issue_project_keys = excluded.issue_project_keys,
  updated_at = now();
