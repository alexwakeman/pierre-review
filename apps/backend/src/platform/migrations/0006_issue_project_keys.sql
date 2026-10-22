-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Adds an optional per-account allowlist of
-- Jira/Linear project prefixes (comma-separated, e.g. "ENG,PROJ"). When set, ticket detection
-- emits ONLY keys with a listed prefix — eliminating false positives (GPT-4, node-18, …). When
-- null/blank, the enricher falls back to heuristics. Additive nullable column, no backfill.

ALTER TABLE pro_settings ADD COLUMN issue_project_keys text;
