-- PENDING → "AI REVIEWS" SINCE THE READER LAST LOOKED (docs/BACKEND.md § The AI reviews list): when the
-- reader last looked at the tab in this workspace. NULL = never (the list covers the last 7 days).
-- Additive and nullable; no backfill.
ALTER TABLE `workspaces` ADD `ai_reviews_seen_at` integer;
