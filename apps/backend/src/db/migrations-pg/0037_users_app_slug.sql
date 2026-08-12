-- Bot Tuning Advisor discovery: capture the GitHub App slug behind a bot's comments — the
-- Postgres twin of sqlite 0050_users_app_slug.sql. HAND-WRITTEN ADDITIVE, like every pg
-- migration since 0023: never regenerate the baseline with `pnpm db:generate:pg`, which
-- squashes it.
--
-- See the sqlite twin for the full argument. In short: `users.app_slug` persists the
-- `performed_via_github_app.slug` the app-attribution probe already receives (global fact,
-- global table, nullable, never cleared by a later app-less comment).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "app_slug" text;
