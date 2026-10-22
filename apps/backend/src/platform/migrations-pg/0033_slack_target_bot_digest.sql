-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite
-- 0033_slack_target_bot_digest.sql, where the WHOLE rationale lives — why the account-wide
-- justification died with plugin 0030 (one flag was deciding the CONTENT of N independently
-- scheduled per-workspace messages), why the existing flag is MIGRATED rather than defaulted, why
-- the data half is an UPDATE and never an INSERT (a row here IS a delivery, and `webhook_url` is
-- NOT NULL), and why `pro_settings.bot_slack_digest` is left dormant rather than dropped.
--
-- ⚠ A PLUGIN pg MIGRATION THAT FAILS IS DOWNGRADED TO A WARNING BY THE HOST'S RUNNER, which
-- silently drops the WHOLE plugin to OSS mode — so every statement here is idempotent and
-- replay-safe. Mirrored BY EYE: this package has no schema-parity test.
--
-- Two intentional dialect divergences: the column is a real `boolean` here against sqlite's
-- int-bool (the standing pairing on this table's sibling flags), so the predicate and the assigned
-- value are `true` rather than `1` — CLAUDE.md's raw-`sql` boolean rule; and `updated_at` takes
-- `now()` into a timestamptz where sqlite writes `unixepoch()` into an integer.

ALTER TABLE workspace_slack_targets ADD COLUMN IF NOT EXISTS bot_digest boolean;

UPDATE workspace_slack_targets
SET bot_digest = true, updated_at = now()
WHERE account_id IN (SELECT account_id FROM pro_settings WHERE bot_slack_digest = true);
