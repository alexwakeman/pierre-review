-- FOLLOWING LINKS FROM A WEB PAGE — the Postgres twin of migrations/0124_reference_doc_crawl.sql
-- (read its header). ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "reference_docs" ADD COLUMN IF NOT EXISTS "crawl_json" jsonb;
