-- Server-side Activity-Feed "seen" marker (additive). `feed_last_seen_at` records the
-- last time this account viewed the consolidated feed, so "new FYI since you were last
-- here" is server-truth (consistent across devices) instead of a client localStorage
-- heuristic — the successor to the removed per-item "Done". Nullable; existing rows stay
-- NULL (no baseline yet → nothing counts as new until the first feed view sets it).
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
ALTER TABLE `accounts` ADD `feed_last_seen_at` integer;
