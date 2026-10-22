-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names snake_case to match
-- src/insights/schema.sqlite.ts. Idempotent (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS sprint_reports (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  insights_hash text NOT NULL,
  model text NOT NULL,
  summary text NOT NULL,
  cost_usd real,
  input_tokens integer,
  output_tokens integer,
  sprint_from integer,
  sprint_to integer,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS sr_account ON sprint_reports (account_id);
