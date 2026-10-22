-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0023_chat_answer_window.sql. Run once by the host's runPluginMigrations
-- (tracked in pro_migrations; discovered by filename sort, no journal, no statement-breakpoint
-- markers). See the sqlite twin for what the column holds and why it is not backfilled.
--
-- TWO LAYERS OF SAFETY, both for the standing reason: A PLUGIN-MIGRATION FAILURE IS TOTAL AND
-- SILENT. runPluginMigrations rethrows, bind.ts catches it and logs `pro register() failed — OSS
-- mode`, and the ENTIRE plugin goes dark on a cloud deploy — every capability false, every
-- /api/pro/* 404, nothing thrown that anyone would connect to this file.
--   1. ADD COLUMN IF NOT EXISTS — a database that somehow already has the column is a no-op.
--   2. The DO block downgrades any surviving error to a WARNING, per the standing rule.
--
-- WHAT THE WARNING PATH COSTS: `listSprintChatHistory` does a bare `select()` over this table, so
-- a database that took the warning would 500 on the chat History panel and on nothing else — the
-- ask path itself keeps working, since the history INSERT is already wrapped in a swallowing
-- try/catch. Cheaper than a raise, which takes the whole plugin dark. Fix by deleting the
-- pro_migrations row for this file and restarting.

DO $$
BEGIN
  ALTER TABLE sprint_chat_history ADD COLUMN IF NOT EXISTS answer_window text;
EXCEPTION WHEN others THEN
  RAISE WARNING 'pro 0023: sprint_chat_history.answer_window NOT added (%). The chat History panel reads this column and will fail until it exists — delete the pro_migrations row for this file and restart once the cause is cleared.', SQLERRM;
END $$;
