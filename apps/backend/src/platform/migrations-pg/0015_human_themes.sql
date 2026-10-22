-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite 0015.
-- Idempotent.

CREATE TABLE IF NOT EXISTS human_theme_reports (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  scope_key text NOT NULL DEFAULT 'all',
  window_kind text NOT NULL DEFAULT 'rolling_14',
  payload_hash text NOT NULL,
  result_json text NOT NULL,
  model text NOT NULL,
  cost_usd double precision,
  input_tokens integer,
  output_tokens integer,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS htr_account_scope_window
  ON human_theme_reports (account_id, scope_key, window_kind);
