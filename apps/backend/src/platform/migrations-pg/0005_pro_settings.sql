-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite 0005.
-- Idempotent.

CREATE TABLE IF NOT EXISTS pro_settings (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  sprint_cadence_days integer,
  sprint_start_at timestamptz,
  slack_webhook_url text,
  slack_cadence text,
  slack_hour1 integer,
  slack_hour2 integer,
  slack_timezone text,
  slack_last_sent_at timestamptz,
  slack_last_sent_slot text,
  ai_update_mode text,
  ai_interval_minutes integer,
  issue_provider text,
  issue_base_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pro_settings_account ON pro_settings (account_id);
