-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names snake_case to match
-- src/insights/schema.sqlite.ts. Idempotent (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS retro_reports (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  inputs_hash text NOT NULL,
  model text NOT NULL,
  summary text NOT NULL,
  cost_usd real,
  input_tokens integer,
  output_tokens integer,
  window_from integer,
  window_to integer,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS rr_account ON retro_reports (account_id);
