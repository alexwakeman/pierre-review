-- @pierre/pro plugin migration (Postgres / cloud mode). Twin of the SQLite
-- 0040_slack_event_signals.sql, where the rationale lives. Every statement is idempotent: a failed
-- plugin pg migration is downgraded to a warning and drops the whole plugin to OSS mode. Booleans
-- are real `boolean` here against sqlite's int-bool (the standing pairing on this table).
ALTER TABLE workspace_slack_targets ADD COLUMN IF NOT EXISTS notify_reviews boolean;
ALTER TABLE workspace_slack_targets ADD COLUMN IF NOT EXISTS notify_merges boolean;

CREATE TABLE IF NOT EXISTS slack_signal_notices (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  kind text NOT NULL,
  ref_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS slack_signal_notices_account_kind_ref
  ON slack_signal_notices (account_id, kind, ref_id);
