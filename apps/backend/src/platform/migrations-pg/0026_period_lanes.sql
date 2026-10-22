-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of
-- ../migrations/0026_period_lanes.sql — see that file for WHY this column exists.
--
-- Wrapped in DO $$ … EXCEPTION like every other plugin ALTER: a plugin-migration failure is TOTAL
-- and SILENT (it drops the whole plugin to OSS mode), so an ALTER that cannot apply must warn
-- loudly and let the rest of the plugin keep working rather than take the feature set down with
-- it. The column is nullable, so a row written without it reads back as "no breakdown".
DO $$
BEGIN
  ALTER TABLE workspace_period_reports ADD COLUMN IF NOT EXISTS lanes_json text;
EXCEPTION WHEN others THEN
  RAISE WARNING 'pro 0026: workspace_period_reports.lanes_json NOT added (%). The period report selects this column by name, so the Reports surface will fail until it exists — delete the pro_migrations row for this file and restart once the cause is cleared.', SQLERRM;
END $$;
