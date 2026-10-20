-- FOLLOWING LINKS FROM A WEB PAGE (2026-10-20; docs/REFERENCE-DOCS.md § Following links). CORE, free,
-- LOCAL ONLY (agentic). The Postgres twin is migrations-pg/0111_reference_doc_crawl.sql.
--
--   reference_docs.crawl_json   NEW, nullable JSON (ReferenceDocCrawl): a web page added with "Follow
--                               links" — the depth, the page cap and what the last build read. NULL =
--                               one page or an uploaded file (every existing row). No new table, so no
--                               accountScopedTables / erasure change (the row is already covered).
ALTER TABLE `reference_docs` ADD COLUMN `crawl_json` text;
