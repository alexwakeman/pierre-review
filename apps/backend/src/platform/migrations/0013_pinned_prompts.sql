-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names snake_case to match
-- src/insights/schema.sqlite.ts. Idempotent (CREATE ... IF NOT EXISTS).
--
-- Saved, re-runnable ad-hoc "Ask about the sprint" prompts, per (account, scope). want_chart /
-- want_bots are 0/1 integers (sqlite booleans).

CREATE TABLE IF NOT EXISTS pinned_prompts (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  scope_key text NOT NULL DEFAULT 'all',
  text text NOT NULL,
  want_chart integer NOT NULL DEFAULT 0,
  want_bots integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS pinned_prompts_account_scope
  ON pinned_prompts (account_id, scope_key);
