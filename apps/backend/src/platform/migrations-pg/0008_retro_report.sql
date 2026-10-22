-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the
-- SQLite 0008. Idempotent.

CREATE TABLE IF NOT EXISTS retro_reports (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  inputs_hash text NOT NULL,
  model text NOT NULL,
  summary text NOT NULL,
  cost_usd double precision,
  input_tokens integer,
  output_tokens integer,
  window_from timestamptz,
  window_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rr_account ON retro_reports (account_id);
