-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0022_annotation_evidence.sql. Run once by the host's runPluginMigrations
-- (tracked in pro_migrations; discovered by filename sort, no journal, no statement-breakpoint
-- markers). See the sqlite twin for what the column holds and why it is stored rather than
-- re-derived.
--
-- TWO LAYERS OF SAFETY, and both are here for the same reason: A PLUGIN-MIGRATION FAILURE IS
-- TOTAL AND SILENT. runPluginMigrations rethrows, bind.ts catches it and logs `pro register()
-- failed — OSS mode`, and the ENTIRE plugin goes dark on a cloud deploy — every capability
-- false, every /api/pro/* 404, nothing thrown that anyone would connect to this file.
--   1. ADD COLUMN IF NOT EXISTS — a database that somehow already has the column is a no-op.
--   2. The DO block downgrades any surviving error to a WARNING, per the standing rule for plugin
--      migrations.
--
-- ⚠ BE HONEST ABOUT WHAT THE WARNING PATH COSTS, because it is not free here the way it is for a
-- data backfill: `readPrAnnotationRows` SELECTs this column, so a database that took the warning
-- would 500 on the annotations GET — the "Check review" surface breaks, though the rest of the
-- plugin (digests, Insights, the advisor, AI Fix) keeps serving. That is still the better trade
-- than a raise, which takes ALL of it dark with no error anyone would connect to this file. The
-- realistic failure modes are a lock timeout or a permissions problem, both of which are fixed by
-- deleting the row from `pro_migrations` and restarting; the table itself cannot be missing (0017
-- creates it and migrations are filename-ordered).

DO $$
BEGIN
  ALTER TABLE pr_comment_annotations ADD COLUMN IF NOT EXISTS evidence text;
EXCEPTION WHEN others THEN
  RAISE WARNING 'pro 0022: pr_comment_annotations.evidence NOT added (%). The annotations routes read this column and will fail until it exists — delete the pro_migrations row for this file and restart once the cause is cleared.', SQLERRM;
END $$;
