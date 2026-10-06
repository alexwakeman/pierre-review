-- AUTO REVIEW DAILY CAP, PER WORKSPACE. How many auto Claude reviews a workspace may start per UTC
-- day. OVERRIDES ONLY: NULL = the product default (20, `AUTO_REVIEW_DAILY_CAP`), resolved through
-- `resolveAutoReviewDailyCap` (review/claude-review/auto-settings.ts); the PUT route bounds it
-- 1..500. Nullable with no default, so no workspace insert has to name it. The Postgres twin is
-- migrations-pg/0072_auto_review_daily_cap.sql.
ALTER TABLE `workspaces` ADD `auto_review_daily_cap` integer;
