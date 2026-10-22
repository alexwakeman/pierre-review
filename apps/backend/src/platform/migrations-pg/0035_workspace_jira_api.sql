-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0035_workspace_jira_api.sql, where the rationale lives: Jira API access per
-- workspace (email, the token — sealed `sealed:v1:…` whenever the host has ENCRYPTION_KEY, which
-- cloud always does — and the acceptance-criteria field id + name). No backfill, no new erasure
-- entry (the table is already erased with the account), tenancy unchanged.
--
-- ⚠ A PLUGIN pg MIGRATION THAT FAILS IS DOWNGRADED TO A WARNING and silently drops the whole
-- plugin to OSS mode, so every statement is replay-safe (`IF NOT EXISTS`). Mirrored BY EYE: this
-- package has no schema-parity test.

ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS jira_email text;
ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS jira_token text;
ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS jira_ac_field_id text;
ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS jira_ac_field_name text;
