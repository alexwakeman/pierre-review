-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0029_workspace_sprint_cadence.sql. Run once by the host's runPluginMigrations
-- (tracked in pro_migrations; discovered by filename sort, no journal, no statement-breakpoint
-- markers). See the sqlite twin for the full rationale: why the cadence gets its OWN table rather
-- than a wider `pro_settings` key, why the account columns stay as the DEFAULT with exactly one
-- reader of the fallback, why tenancy is a named composite FK, and why `cadence_days` joins
-- `workspace_period_reports`' unique index.
--
-- ⚠ WHY NOTHING HERE IS WRAPPED IN A WARNING-DOWNGRADING DO BLOCK. The standing rule for plugin
-- migrations is to downgrade a failure to a WARNING, because A PLUGIN-MIGRATION FAILURE IS TOTAL
-- AND SILENT: runPluginMigrations rethrows, bind.ts catches it and logs `pro register() failed —
-- OSS mode`, and the ENTIRE plugin goes dark — every capability false, every /api/pro/* 404,
-- nothing thrown that anyone would connect to this file. That trade only makes sense when the
-- feature can DEGRADE. Neither statement here can:
--   • `pro_workspace_settings` is SELECTed by name by `resolveSprintCadence`, which every Reports,
--     Insights and Slack window now runs through — a swallowed CREATE would record the migration
--     as applied and leave those paths 500ing forever, with no way back except editing
--     pro_migrations by hand.
--   • The index swap is worse than that. `persistReport`'s ON CONFLICT names the NEW index; if the
--     swap were swallowed, every period-report generation would raise "no unique or exclusion
--     constraint matching the ON CONFLICT specification" at RUNTIME — and if only the DROP landed,
--     the table would have no unique key at all and would silently accumulate duplicate reports.
-- A raise is the honest outcome, and `IF NOT EXISTS` / `IF EXISTS` already cover the benign
-- replay case. (Same call 0021 and 0025 made for their CREATEs.)

CREATE TABLE IF NOT EXISTS pro_workspace_settings (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  sprint_cadence_days integer,
  sprint_start_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pro_workspace_settings_workspace_account_fk"
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS pws_account_ws
  ON pro_workspace_settings (account_id, workspace_id);

DROP INDEX IF EXISTS wpr_account_ws_period_model;

CREATE UNIQUE INDEX IF NOT EXISTS wpr_account_ws_period_model_cadence
  ON workspace_period_reports (account_id, workspace_id, period_key, model, cadence_days);
