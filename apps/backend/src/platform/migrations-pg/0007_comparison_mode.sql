-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite 0007.
-- Per-account comparison-window model for the Insights ('rolling_7' | 'rolling_14' | 'sprint');
-- null → the 'rolling_14' default. Idempotent additive nullable column.

ALTER TABLE pro_settings ADD COLUMN IF NOT EXISTS comparison_mode text;
