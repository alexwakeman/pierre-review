-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations). Column names snake_case to match src/settings/schema.sqlite.ts.
-- Bot-Triage Platform (WS8) control-surface settings: in-house detection toggles + login allowlist,
-- Pierre tag/footer, Slack bot digest, standing auto-resolve, and per-vendor cost. Additive,
-- nullable, no backfill (null reads as the store's documented default). SQLite has no
-- "ADD COLUMN IF NOT EXISTS", but pro_migrations tracks applied files so each runs exactly once.
ALTER TABLE pro_settings ADD COLUMN bot_inhouse_detect integer;
ALTER TABLE pro_settings ADD COLUMN bot_auto_tag integer;
ALTER TABLE pro_settings ADD COLUMN bot_login_allowlist text;
ALTER TABLE pro_settings ADD COLUMN bot_deep_detect integer;
ALTER TABLE pro_settings ADD COLUMN bot_ai_tiebreak integer;
ALTER TABLE pro_settings ADD COLUMN bot_tag_pierre integer;
ALTER TABLE pro_settings ADD COLUMN bot_pierre_footer integer;
ALTER TABLE pro_settings ADD COLUMN bot_slack_digest integer;
ALTER TABLE pro_settings ADD COLUMN bot_auto_resolve integer;
ALTER TABLE pro_settings ADD COLUMN bot_auto_resolve_days integer;
ALTER TABLE pro_settings ADD COLUMN bot_cost_json text;
