-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0025_period_reports.sql. Run once by the host's runPluginMigrations (tracked in
-- pro_migrations; discovered by filename sort, no journal, no statement-breakpoint markers). See
-- the sqlite twin for the full rationale: why the artifact is STORED rather than recomputed, why
-- `model` is in the unique key, why a backfilled row stores '' and never NULL, why every row
-- carries its own cadence + repo set + coverage, and why there is deliberately no FK onto
-- `workspaces`.
--
-- ⚠ WHY THE CREATE IS BARE AND ONLY THE ALTER IS WRAPPED. The standing rule for plugin migrations
-- is to downgrade a failure to a WARNING, because A PLUGIN-MIGRATION FAILURE IS TOTAL AND SILENT:
-- runPluginMigrations rethrows, bind.ts catches it and logs `pro register() failed — OSS mode`, and
-- the ENTIRE plugin goes dark on a cloud deploy — every capability false, every /api/pro/* 404,
-- nothing thrown that anyone would connect to this file. That trade only makes sense when the
-- feature can degrade. It cannot here: without `workspace_period_reports` there is no Reports
-- surface at all, so swallowing a failed CREATE would record the migration as applied and leave
-- every reports route 500ing forever with no way back except editing pro_migrations by hand. A
-- raise is the honest outcome, and `IF NOT EXISTS` already covers the one benign case. (Same call
-- 0021 made for the advisor's three tables.)
--
-- The ALTER is the opposite case and IS wrapped, exactly like 0023/0024:
--   1. ADD COLUMN IF NOT EXISTS — a database that somehow already has the column is a no-op.
--   2. The DO block downgrades any surviving error to a WARNING.
-- What that warning path costs: the Pro settings store SELECTs `report_model` by name, so a
-- database that took it would 500 on GET/PATCH of the Pro settings route and fall back nowhere —
-- the reports themselves still generate on the config default. Cheaper than a raise, which takes
-- every Pro feature dark. Fix by deleting this file's row from `pro_migrations` and restarting
-- once the cause (a lock timeout or a permissions problem, realistically) is cleared.

CREATE TABLE IF NOT EXISTS workspace_period_reports (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  period_key text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  grain text NOT NULL DEFAULT 'sprint',
  cadence_days integer NOT NULL,
  repo_ids_json text NOT NULL,
  coverage_json text NOT NULL,
  metrics_json text NOT NULL,
  metrics_schema_version integer NOT NULL,
  comparison_json text,
  forecast_json text,
  movements_json text,
  suggested_json text,
  narrative_md text,
  model text DEFAULT '',
  payload_hash text NOT NULL,
  data_fingerprint text NOT NULL,
  credits_spent double precision,
  input_tokens integer,
  output_tokens integer,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wpr_account_ws_period_model
  ON workspace_period_reports (account_id, workspace_id, period_key, model);

DO $$
BEGIN
  ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS report_model text;
EXCEPTION WHEN others THEN
  RAISE WARNING 'pro 0025: pro_settings.report_model NOT added (%). The Pro settings store selects this column by name and that route will fail until it exists — delete the pro_migrations row for this file and restart once the cause is cleared.', SQLERRM;
END $$;
