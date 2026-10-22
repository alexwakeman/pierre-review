-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite 0021.
-- Idempotent. See the sqlite twin for the full rationale (three account-scoped tables; the
-- named composite FK makes profile tenancy structural; ON DELETE CASCADE because core's
-- deleteWorkspace cannot re-home plugin rows across the open-core boundary).

CREATE TABLE IF NOT EXISTS advisor_recommendations (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  bot_user_id integer NOT NULL,
  intent text NOT NULL,
  dedupe_key text NOT NULL,
  target_json text NOT NULL,
  evidence_json text NOT NULL,
  retro_json text,
  output_json text,
  status text NOT NULL,
  pr_repo_id integer,
  pr_number integer,
  pr_url text,
  issue_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS advrec_account_ws_key
  ON advisor_recommendations (account_id, workspace_id, dedupe_key);

CREATE TABLE IF NOT EXISTS advisor_bot_profiles (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  bot_user_id integer NOT NULL,
  kind_hint text,
  config_path text,
  owner_contact text,
  owner_repo text,
  notes text,
  profile_source text,
  manifest_json text,
  manifest_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "advisor_bot_profiles_workspace_account_fk"
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS advprof_account_ws_bot
  ON advisor_bot_profiles (account_id, workspace_id, bot_user_id);

CREATE TABLE IF NOT EXISTS advisor_config_events (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  repo_id integer NOT NULL,
  bot_user_id integer NOT NULL,
  source text NOT NULL,
  occurred_at timestamptz NOT NULL,
  config_path text,
  description text,
  recommendation_id integer,
  pr_number integer,
  pr_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS advevt_account_repo_occurred
  ON advisor_config_events (account_id, repo_id, occurred_at);
