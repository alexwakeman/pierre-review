-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0034_flow_pointers.sql. Run once by the host's runPluginMigrations (tracked in
-- pro_migrations; discovered by filename sort, no journal, no statement-breakpoint markers). See
-- the sqlite twin for the rationale: the evidence and the links are never stored, only the
-- model's pointers; one row per (account, `ws:<id>|d:<days>`); no FK, erased with the account.

CREATE TABLE IF NOT EXISTS pro_flow_pointers (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  scope_key text NOT NULL,
  payload_hash text NOT NULL,
  output text NOT NULL,
  model text NOT NULL,
  pr_count integer NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pro_flow_pointers_account_scope
  ON pro_flow_pointers (account_id, scope_key);
