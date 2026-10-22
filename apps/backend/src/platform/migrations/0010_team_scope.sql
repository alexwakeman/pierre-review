-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names snake_case to match
-- src/insights/schema.sqlite.ts. Idempotent where possible.
--
-- Per-team AI: the sprint + retro report caches gain a `scope_key` ('all' | 'none' |
-- '<teamId>') so a team's report is cached independently of the all-repos one; their
-- unique index widens from (account_id) to (account_id, scope_key). A new preset_reports
-- table caches one-click "ask about this scope" answers per (account, scope, preset).

ALTER TABLE sprint_reports ADD COLUMN scope_key text NOT NULL DEFAULT 'all';
ALTER TABLE retro_reports ADD COLUMN scope_key text NOT NULL DEFAULT 'all';

DROP INDEX IF EXISTS sr_account;
DROP INDEX IF EXISTS rr_account;
CREATE UNIQUE INDEX IF NOT EXISTS sr_account_scope ON sprint_reports (account_id, scope_key);
CREATE UNIQUE INDEX IF NOT EXISTS rr_account_scope ON retro_reports (account_id, scope_key);

CREATE TABLE IF NOT EXISTS preset_reports (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  scope_key text NOT NULL DEFAULT 'all',
  preset_key text NOT NULL,
  markdown text NOT NULL,
  payload_hash text NOT NULL,
  model text NOT NULL,
  cost_usd real,
  input_tokens integer,
  output_tokens integer,
  generated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS pr_account_scope_key
  ON preset_reports (account_id, scope_key, preset_key);
