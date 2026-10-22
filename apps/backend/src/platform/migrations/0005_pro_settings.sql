-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names snake_case to match
-- src/settings/schema.sqlite.ts. Idempotent (CREATE ... IF NOT EXISTS).
-- Per-account Pro configuration: sprint window + Slack digest + AI-update policy + Jira/Linear.

CREATE TABLE IF NOT EXISTS pro_settings (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  sprint_cadence_days integer,
  sprint_start_at integer,
  slack_webhook_url text,
  slack_cadence text,
  slack_hour1 integer,
  slack_hour2 integer,
  slack_timezone text,
  slack_last_sent_at integer,
  slack_last_sent_slot text,
  ai_update_mode text,
  ai_interval_minutes integer,
  issue_provider text,
  issue_base_url text,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS pro_settings_account ON pro_settings (account_id);
