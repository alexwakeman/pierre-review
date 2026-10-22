-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names snake_case to match
-- src/advisor/schema.sqlite.ts. Idempotent (CREATE ... IF NOT EXISTS). No
-- statement-breakpoint markers (the plugin migrator execs the whole file as one blob).
--
-- Bot Tuning Advisor storage: three account-scoped tables, none PR-keyed.
--   advisor_recommendations — one DECIDED recommendation per (account, workspace,
--     dedupe_key); findings stay pure query results, a row exists only once the user acts.
--   advisor_bot_profiles — the one-bot-object rule extended: T1 ask-once answers + the T3
--     confirmed manifest, one row per (account, workspace, bot). workspace_id arrives in
--     REQUEST BODIES, so tenancy is STRUCTURAL: the named composite FK
--     advisor_bot_profiles_workspace_account_fk makes the (workspace, account) PAIR the
--     thing that must exist (it leans on core's workspaces_id_account unique index).
--     ON DELETE CASCADE: a deleted workspace takes its advisor profiles with it — core's
--     deleteWorkspace cannot re-home rows it cannot name across the open-core boundary.
--   advisor_config_events — append-only anchor log (no unique; recommendation_id is a soft
--     reference on purpose).

CREATE TABLE IF NOT EXISTS advisor_recommendations (
  id integer PRIMARY KEY AUTOINCREMENT,
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
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS advrec_account_ws_key
  ON advisor_recommendations (account_id, workspace_id, dedupe_key);

CREATE TABLE IF NOT EXISTS advisor_bot_profiles (
  id integer PRIMARY KEY AUTOINCREMENT,
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
  manifest_confirmed_at integer,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT "advisor_bot_profiles_workspace_account_fk"
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS advprof_account_ws_bot
  ON advisor_bot_profiles (account_id, workspace_id, bot_user_id);

CREATE TABLE IF NOT EXISTS advisor_config_events (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  repo_id integer NOT NULL,
  bot_user_id integer NOT NULL,
  source text NOT NULL,
  occurred_at integer NOT NULL,
  config_path text,
  description text,
  recommendation_id integer,
  pr_number integer,
  pr_url text,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS advevt_account_repo_occurred
  ON advisor_config_events (account_id, repo_id, occurred_at);
