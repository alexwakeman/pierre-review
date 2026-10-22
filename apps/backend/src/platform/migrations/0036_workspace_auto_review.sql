-- @pierre/pro plugin migration (SQLite / local mode). Discovered by FILENAME SORT, no journal, no
-- statement-breakpoint markers (the plugin migrator execs the file as one blob). Postgres twin:
-- migrations-pg/0036_workspace_auto_review.sql.
--
-- AUTO CLAUDE REVIEW, PER WORKSPACE. Two nullable columns on the row that already holds the
-- workspace's other Pro settings:
--
--   auto_review_enabled     1 = review each new human PR in this workspace automatically. NULL/0 = off.
--   auto_review_enabled_at  when it was last switched ON (off -> on). The sweeper reviews only PRs
--                           OPENED at or after it, so a first sync, a backfill or adding a repo can
--                           never make an old PR look new. Re-stamped on every off -> on.
--
-- No backfill: NULL is "off", which is right for every existing row. Erasure is already covered
-- (`pro_workspace_settings` is in `registerAccountErasure`). Tenancy is unchanged (0029's FK).
--
-- ⚠ NOT BLIND-REPLAYABLE (SQLite has no ADD COLUMN IF NOT EXISTS); `pro_migrations` guarantees
-- run-once.
ALTER TABLE pro_workspace_settings ADD COLUMN auto_review_enabled integer;
ALTER TABLE pro_workspace_settings ADD COLUMN auto_review_enabled_at integer;
