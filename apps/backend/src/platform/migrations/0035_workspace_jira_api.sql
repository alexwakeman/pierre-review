-- @pierre/pro plugin migration (SQLite / local mode). Discovered by FILENAME SORT, no journal, no
-- statement-breakpoint markers (the plugin migrator execs the file as one blob). Postgres twin:
-- migrations-pg/0035_workspace_jira_api.sql.
--
-- JIRA API ACCESS, PER WORKSPACE. Four nullable columns on the row that already holds the
-- workspace's tracker (0031), so Claude Review can fill its user story from a detected ticket:
--
--   jira_email          Jira Cloud signs in with email + API token (HTTP Basic). NULL = send the
--                       token as a Bearer personal access token (Server / Data Center).
--   jira_token          THE SECRET. `sealed:v1:<iv:tag:ct>` when the host has ENCRYPTION_KEY
--                       (always in cloud), `plain:<token>` on a local install without one. NEVER
--                       returned by a route, never logged, never in the account export.
--   jira_ac_field_id    the custom field holding acceptance criteria (`customfield_10042`); ids
--   jira_ac_field_name  differ per Jira site, so it is chosen per workspace. NULL = the criteria
--                       live in the description.
--
-- No backfill: NULL everywhere is "no Jira API access", which is right for every existing row.
-- No new erasure entry: `pro_workspace_settings` is already in `registerAccountErasure`
-- (retention.ts), and it now holds a credential, so that entry matters more than it did.
-- Tenancy is unchanged: the named composite FK from 0029 still binds (workspace_id, account_id).
--
-- ⚠ NOT BLIND-REPLAYABLE (SQLite has no ADD COLUMN IF NOT EXISTS); `pro_migrations` guarantees
-- run-once. The pg twin uses IF NOT EXISTS because a failing plugin pg migration is downgraded to a
-- warning and silently drops the whole plugin to OSS mode.
ALTER TABLE pro_workspace_settings ADD COLUMN jira_email text;
ALTER TABLE pro_workspace_settings ADD COLUMN jira_token text;
ALTER TABLE pro_workspace_settings ADD COLUMN jira_ac_field_id text;
ALTER TABLE pro_workspace_settings ADD COLUMN jira_ac_field_name text;
