-- REFERENCE DOCS IN REVIEWS (2026-10-16; docs/REFERENCE-DOCS.md § Use in reviews). Additive, nullable.
--   claude_reviews.doc_references          the reference-library passages a PR review used, each
--                                          server-checked (the link names a built section of the
--                                          workspace's library; the quote is in that section). NULL =
--                                          the run did not read the library.
--   claude_review_findings.doc_citations   the library sections one finding rests on. NULL = none.
-- The ticket review and the sprint check keep theirs inside their existing JSON columns
-- (ticket_reviews.assessment.references, sprint_assessments.body_json.references): no column there.
ALTER TABLE `claude_reviews` ADD `doc_references` text;
--> statement-breakpoint
ALTER TABLE `claude_review_findings` ADD `doc_citations` text;
