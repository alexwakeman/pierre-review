-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0030_workspace_slack_targets.sql. Run once by the host's runPluginMigrations
-- (tracked in pro_migrations; discovered by filename sort, no journal, no statement-breakpoint
-- markers). See the sqlite twin for the full rationale: why the delivery target gets its OWN table,
-- why there is NO account-level fallback column (null-means-inherit is a named bug class here),
-- why the old `pro_settings.slack_*` columns are migrated then left dormant rather than dropped,
-- why `slack_last_sent_slot` MUST be carried across, why tenancy is a named composite FK, and the
-- re-made decision to keep the webhook URL plaintext.
--
-- ⚠ WHY NOTHING HERE IS WRAPPED IN A WARNING-DOWNGRADING DO BLOCK. The standing rule for plugin
-- migrations is to downgrade a failure to a WARNING, because A PLUGIN-MIGRATION FAILURE IS TOTAL
-- AND SILENT: runPluginMigrations rethrows, bind.ts catches it and logs `pro register() failed —
-- OSS mode`, and the ENTIRE plugin goes dark — every capability false, every /api/pro/* 404,
-- nothing thrown that anyone would connect to this file. That trade only makes sense when the
-- feature can DEGRADE. This one cannot:
--   • `workspace_slack_targets` is SELECTed by name by the digest sweep and by both
--     `/api/pro/slack/targets` routes. A swallowed CREATE would record the migration as applied and
--     leave the Slack section 500ing forever, with no way back except editing pro_migrations by
--     hand.
--   • A swallowed INSERT is WORSE THAN AN ERROR: every existing customer's configured webhook
--     would simply stop delivering, silently, with the Settings modal showing an empty list and
--     the secret still sitting unreachable in a dormant column.
-- A raise is the honest outcome, and `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` already cover the
-- benign replay case. (Same call 0021, 0025 and 0029 made.)

CREATE TABLE IF NOT EXISTS workspace_slack_targets (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  webhook_url text NOT NULL,
  cadence text,
  hour1 integer,
  hour2 integer,
  timezone text,
  last_sent_at timestamptz,
  last_sent_slot text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_slack_targets_workspace_account_fk"
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS wst_account_ws
  ON workspace_slack_targets (account_id, workspace_id);

INSERT INTO workspace_slack_targets (
  account_id, workspace_id, webhook_url, cadence, hour1, hour2, timezone,
  last_sent_at, last_sent_slot
)
SELECT
  s.account_id,
  w.id,
  btrim(s.slack_webhook_url),
  COALESCE(s.slack_cadence, 'off'),
  s.slack_hour1,
  s.slack_hour2,
  s.slack_timezone,
  s.slack_last_sent_at,
  s.slack_last_sent_slot
FROM pro_settings s
JOIN workspaces w ON w.account_id = s.account_id AND w.is_default = true
WHERE s.slack_webhook_url IS NOT NULL AND btrim(s.slack_webhook_url) <> ''
ON CONFLICT (account_id, workspace_id) DO NOTHING;
