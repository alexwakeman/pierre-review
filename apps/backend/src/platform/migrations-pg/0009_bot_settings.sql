-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite 0009.
-- Bot-Triage Platform (WS8) control-surface settings columns. Idempotent additive nullable scalars
-- (booleans as pg boolean; the SQLite twin uses int-bool). No backfill (null reads as the default).
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_inhouse_detect boolean;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_auto_tag boolean;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_login_allowlist text;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_deep_detect boolean;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_ai_tiebreak boolean;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_tag_pierre boolean;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_pierre_footer boolean;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_slack_digest boolean;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_auto_resolve boolean;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_auto_resolve_days integer;
ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS bot_cost_json text;
