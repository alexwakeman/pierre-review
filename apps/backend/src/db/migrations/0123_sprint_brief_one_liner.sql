-- SPRINT BRIEF ONE-LINER (2026-10-20; docs/CLAUDE-REVIEW.md § Sprint briefs). This Sprint's cards show
-- a one-line summary of each ticket (≤ 90 characters), written by the brief pass from
-- SPRINT_BRIEF_VERSION 5. Nullable: a row written before version 5 has none and is no longer current,
-- so the next pass rewrites it. The Postgres twin is migrations-pg/0110_sprint_brief_one_liner.sql.
ALTER TABLE `sprint_briefs` ADD `one_liner` text;
