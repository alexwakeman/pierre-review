-- Correlated "does this PR have an event since <cutoff>" EXISTS lookups filter events by
-- pr_id (getTeamInsights open-PR staleness, getOpenPrs, new-since checks, feed joins). With
-- no pr_id index they fall back to events_account_idx and scan every account event per PR
-- (O(open PRs × events)) — the getTeamInsights Overview took ~9s on 14 watched repos. This
-- composite (pr_id, occurred_at) makes the lookup ~450× faster (also resolves the time bound
-- inside the index).
CREATE INDEX IF NOT EXISTS `events_pr_idx` ON `events` (`pr_id`, `occurred_at`);
