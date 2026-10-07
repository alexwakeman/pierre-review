-- REPLIES TO LIMN'S OWN FINDINGS (docs/CLAUDE-REVIEW.md § Replies to Limn's findings). The Postgres
-- twin is migrations-pg/0079_finding_pushback.sql. Additive; no data to move.
--
--   claude_review_findings.pushback   FindingPushbackRecord JSON — the ONE pushback reply an auto
--                                     run posted on this finding's thread after a later review
--                                     disagreed with a reply. Claimed by compare-and-set from NULL
--                                     BEFORE any GitHub write: at most one per thread, ever, never
--                                     retried.
ALTER TABLE `claude_review_findings` ADD `pushback` text;
