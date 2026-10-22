-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the sqlite 0018.
-- Run once by runPluginMigrations (tracked in pro_migrations). Idempotent.
--
-- Drops the Insights "Retro" cache — the sub-tab, route and generator are gone; the
-- retrospective is now a quick-question pill on the grounded Insights chat. Dropped rather than
-- orphaned because the table carried `account_id` and would otherwise stay in the GDPR erasure
-- checklist (and keep both drizzle definitions alive) forever. Migrations 0008 (create) and
-- 0010 (ALTER) must remain — a database replaying from empty still runs them first. The pkey and
-- the `rr_account_scope` unique index drop with the table.

DROP TABLE IF EXISTS "retro_reports";
