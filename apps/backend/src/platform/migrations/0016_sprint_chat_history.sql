-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names snake_case to match
-- src/insights/schema.sqlite.ts. Idempotent (CREATE ... IF NOT EXISTS).
--
-- Stored ad-hoc "Ask about the sprint" chat history, per account (all scopes in one personal
-- history; each row records its own scope_key). Persists the full answer + serialized chart +
-- PR refs so re-opening a past question is free. want_chart / want_bots are 0/1 sqlite booleans.

CREATE TABLE IF NOT EXISTS sprint_chat_history (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  scope_key text NOT NULL DEFAULT 'all',
  question text NOT NULL,
  answer text NOT NULL,
  chart text,
  pr_refs text,
  want_chart integer NOT NULL DEFAULT 0,
  want_bots integer NOT NULL DEFAULT 0,
  model text,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS sch_account_created
  ON sprint_chat_history (account_id, created_at);
