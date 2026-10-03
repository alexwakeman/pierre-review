-- CLAUDE REVIEW: FAILED CI ON THE REVIEWED HEAD.
--
-- claude_reviews.ci_failures (JSON object): the head's CI state when the run looked
-- ({ state, checkCount, failures[] }) and, per failing check, what Claude found — cause,
-- explanation, category (code / test / flaky_or_infra / config / unclear), the related files and
-- whether it can be fixed in the pull request — or 'not_checked' written only by the server (no
-- Actions log, the log could not be read, over the cap, or Claude did not report on it).
-- NULL on every older row (the wire reads it as "did not look at CI"; no backfill).
-- The Postgres twin is migrations-pg/0064_claude_review_ci_failures.sql.
ALTER TABLE `claude_reviews` ADD `ci_failures` text;
