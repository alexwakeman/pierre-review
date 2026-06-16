-- The signed-in user's GitHub display name (additive). `display_name` captures the
-- `name` field from `gh api user` (local) / OAuth `GET /user` (cloud), shown wherever
-- the logged-in identity appears (header, greeting) in place of the @login. Nullable;
-- existing rows stay NULL until the next identity refresh repopulates them (local:
-- ensureLocalAccount refetches when display_name is NULL; cloud: on next sign-in).
-- Postgres baseline is regenerated separately via db:generate:pg.
ALTER TABLE `accounts` ADD `display_name` text;
