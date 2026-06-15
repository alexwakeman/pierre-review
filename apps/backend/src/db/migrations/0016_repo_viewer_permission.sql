-- Viewer's repo permission (additive). `viewer_permission` records the GraphQL
-- Repository.viewerPermission enum (ADMIN/MAINTAIN/WRITE/TRIAGE/READ) captured each
-- activity sync. It drives whether the viewer may approve a PR (WRITE+ and not the
-- author) — surfaced as PrDetail.viewerCanApprove. Nullable; existing rows stay NULL
-- until the next sync repopulates them. Postgres baseline is regenerated separately
-- via db:generate:pg.
ALTER TABLE `repos` ADD `viewer_permission` text;
