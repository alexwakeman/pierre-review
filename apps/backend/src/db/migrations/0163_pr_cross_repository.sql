-- STACKED PRs (docs/FRONTEND.md § Stacked PRs). Additive; no data to move.
--
--   pull_requests.is_cross_repository   GraphQL `isCrossRepository`: the head branch lives in a fork.
--                                       NULL = not observed yet; written only from a received boolean.
ALTER TABLE `pull_requests` ADD `is_cross_repository` integer;
