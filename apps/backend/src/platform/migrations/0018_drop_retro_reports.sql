-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by filename sort and have NO
-- meta/_journal.json; that requirement is CORE-only). Idempotent (DROP ... IF EXISTS).
--
-- Drops the Insights "Retro" cache. The Retro sub-tab, its route and its generator are gone; the
-- retrospective is now a quick-question pill on the grounded Insights chat, which answers from
-- the same payload every other pill uses and needs no table of its own.
--
-- DROPPED rather than orphaned: `retro_reports` carried `account_id`, so leaving it behind would
-- pin it in `eraseProByAccountId`'s GDPR checklist forever — and therefore pin both drizzle table
-- definitions too, deleting the feature while keeping all of its schema surface. The rows are
-- regenerable Haiku output keyed by an inputs hash (no user-authored text); the spend record is a
-- separate `ai_usage` row and is untouched.
--
-- Migrations 0008 (create) and 0010 (ALTER: scope_key + rr_account_scope) MUST stay in place —
-- a database that has not yet replayed the sequence still runs them before reaching this one.
-- The `rr_account_scope` unique index drops with the table; no explicit DROP INDEX is needed.

DROP TABLE IF EXISTS retro_reports;
