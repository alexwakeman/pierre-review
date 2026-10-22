-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite 0006.
-- Optional per-account allowlist of Jira/Linear project prefixes. Idempotent.

ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS issue_project_keys text;
