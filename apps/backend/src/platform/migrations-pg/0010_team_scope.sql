-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite 0010.
-- Idempotent.

ALTER TABLE sprint_reports ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT 'all';
ALTER TABLE retro_reports ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT 'all';

DROP INDEX IF EXISTS sr_account;
DROP INDEX IF EXISTS rr_account;
CREATE UNIQUE INDEX IF NOT EXISTS sr_account_scope ON sprint_reports (account_id, scope_key);
CREATE UNIQUE INDEX IF NOT EXISTS rr_account_scope ON retro_reports (account_id, scope_key);

CREATE TABLE IF NOT EXISTS preset_reports (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  scope_key text NOT NULL DEFAULT 'all',
  preset_key text NOT NULL,
  markdown text NOT NULL,
  payload_hash text NOT NULL,
  model text NOT NULL,
  cost_usd double precision,
  input_tokens integer,
  output_tokens integer,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pr_account_scope_key
  ON preset_reports (account_id, scope_key, preset_key);
