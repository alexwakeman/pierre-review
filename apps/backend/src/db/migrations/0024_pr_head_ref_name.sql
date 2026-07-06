-- The PR's SOURCE branch name (GraphQL `headRefName`), e.g. `feature/PROJ-123-foo` (additive).
-- The standard carrier of a Jira/Linear ticket key; read by the Pro ticket-link enricher
-- (compute-on-read) to render deep links in PR detail. Distinct from `base_ref_name` (the
-- TARGET branch). Nullable; existing rows stay NULL until a sync backfills them.
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
ALTER TABLE `pull_requests` ADD `head_ref_name` text;
