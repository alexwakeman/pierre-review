-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Adds the per-account comparison-window model
-- for the Insights metrics + sprint report: 'rolling_7' | 'rolling_14' | 'sprint'. null → the
-- 'rolling_14' default (a rolling 14-day tracker), so a team can run WITHOUT any sprint dates.
-- 'sprint' uses the existing cadence + start (like-for-like by sprint position). Additive
-- nullable column, no backfill (null reads as rolling_14).

ALTER TABLE pro_settings ADD COLUMN comparison_mode text;
