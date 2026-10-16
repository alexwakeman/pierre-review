-- REFERENCE DOCS IN REVIEWS (2026-10-16). Twin of migrations/0117_review_doc_references.sql, where the
-- contract lives. Additive, nullable.
ALTER TABLE "claude_reviews" ADD COLUMN IF NOT EXISTS "doc_references" jsonb;
--> statement-breakpoint
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "doc_citations" jsonb;
