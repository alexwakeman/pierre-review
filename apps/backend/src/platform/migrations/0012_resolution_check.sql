-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations). Column names snake_case to match src/resolution-check/schema.sqlite.ts.
-- Idempotent (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS addressed_checks (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  repo_id integer NOT NULL,
  pr_id integer NOT NULL,
  target_kind text NOT NULL,
  target_id integer NOT NULL,
  verdict text NOT NULL,
  confidence integer NOT NULL,
  rationale text NOT NULL,
  payload_hash text NOT NULL,
  model text NOT NULL,
  cost_usd real,
  input_tokens integer,
  output_tokens integer,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS ac_account_target ON addressed_checks (account_id, target_kind, target_id);
