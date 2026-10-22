-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names snake_case to match
-- src/human-themes/schema.sqlite.ts. Idempotent (CREATE ... IF NOT EXISTS).
--
-- One cached Human-Themes ("Discussion themes") AI summary per (account, scope, window) — the human
-- sibling of bot_theme_reports. Full result stored as JSON in result_json; keyed by payload_hash.

CREATE TABLE IF NOT EXISTS human_theme_reports (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  scope_key text NOT NULL DEFAULT 'all',
  window_kind text NOT NULL DEFAULT 'rolling_14',
  payload_hash text NOT NULL,
  result_json text NOT NULL,
  model text NOT NULL,
  cost_usd real,
  input_tokens integer,
  output_tokens integer,
  generated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS htr_account_scope_window
  ON human_theme_reports (account_id, scope_key, window_kind);
