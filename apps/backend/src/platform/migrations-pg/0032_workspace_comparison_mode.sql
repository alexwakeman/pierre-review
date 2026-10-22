-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite
-- 0032_workspace_comparison_mode.sql, where the WHOLE rationale lives — why the "reading
-- preference with no per-team meaning" justification was FALSE (the mode COMPOSES with the cadence:
-- 'sprint' is a sprint-position window on a workspace that has one and a rolling fortnight on a
-- workspace that does not, so one account setting produced two window SHAPES), why there is no
-- account fallback beneath the new column, why the backfill copies into EVERY workspace but copies
-- ONLY a mode that differs from the product default, and why `pro_settings.comparison_mode` is left
-- dormant rather than dropped.
--
-- ⚠ A PLUGIN pg MIGRATION THAT FAILS IS DOWNGRADED TO A WARNING BY THE HOST'S RUNNER, which
-- silently drops the WHOLE plugin to OSS mode — so every statement here is written to be idempotent
-- and replay-safe (`IF NOT EXISTS` on the ADD COLUMN, an upsert for the backfill). Mirrored BY EYE:
-- this package has no schema-parity test.
--
-- The only intentional dialect divergence is the `updated_at` expression in the conflict clause:
-- sqlite writes `unixepoch()` into an integer column, pg writes `now()` into a timestamptz.

ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS comparison_mode text;

INSERT INTO pro_workspace_settings (account_id, workspace_id, comparison_mode)
SELECT s.account_id, w.id, s.comparison_mode
FROM pro_settings s
JOIN workspaces w ON w.account_id = s.account_id
WHERE s.comparison_mode IN ('rolling_7', 'sprint')
ON CONFLICT (account_id, workspace_id) DO UPDATE SET
  comparison_mode = excluded.comparison_mode,
  updated_at = now();
