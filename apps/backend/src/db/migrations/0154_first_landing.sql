-- PENDING ON THE FIRST LANDING (2026-11-01; docs/BACKEND.md § My Turn — The first-onboarding
-- lookback, docs/FRONTEND.md § Pending on the first landing). CORE, additive, no backfill.
--
--   repos.first_onboarding                   NEW: 1 for a repo added while the account had no repos,
--                                            or in that same first-run batch. Its My Turn floor is
--                                            its add time minus FIRST_ONBOARDING_LOOKBACK_DAYS; a
--                                            repo added later keeps its add time. Written once, at
--                                            insert (sync/upsert.ts upsertRepo), never updated.
--   accounts.review_suggestion_dismissed_at  NEW: when the reader dismissed Pending's one-time
--                                            "Review your PR with Claude" card. NULL = never.
--
-- Existing repos stay 0: an install that already has repos is past its first landing.
ALTER TABLE `repos` ADD `first_onboarding` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `accounts` ADD `review_suggestion_dismissed_at` integer;
