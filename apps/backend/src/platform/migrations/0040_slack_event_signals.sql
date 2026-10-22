-- @pierre/pro plugin migration (SQLite / local mode). Filename-sorted, no journal, no statement
-- breakpoints. Postgres twin: migrations-pg/0040_slack_event_signals.sql.
--
-- TWO SLACK EVENT SIGNALS, per workspace, both OFF by default:
--   • notify_reviews — post when a Claude Review run succeeds (PR, author, verdict, the run's summary).
--   • notify_merges  — post when a PR is SEEN merging live, naming who merged it.
-- NULL reads as false. They sit on the delivery row because they need its webhook.
--
-- `slack_signal_notices` holds the sent markers: one claimed row per (account, kind, ref), inserted
-- BEFORE the webhook call, so a merge or a run is posted at most once, ever. Account-scoped, so the
-- plugin's erasure hook deletes it (retention.ts).
ALTER TABLE workspace_slack_targets ADD COLUMN notify_reviews integer;
ALTER TABLE workspace_slack_targets ADD COLUMN notify_merges integer;

CREATE TABLE IF NOT EXISTS slack_signal_notices (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  kind text NOT NULL,
  ref_id integer NOT NULL,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS slack_signal_notices_account_kind_ref
  ON slack_signal_notices (account_id, kind, ref_id);
