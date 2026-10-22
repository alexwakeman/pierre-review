-- @pierre/pro plugin migration 0039 — STRIPPED TO A NO-OP at apiVersion 23.
--
-- It added `changed_at` and two indexes to `pro_pr_jira_tickets`. That table is no longer created
-- (0038 is stripped too — the issue tracker moved to CORE, whose `tracker_tickets` carries the
-- column and both indexes from its first migration, core 0088 / pg 0075). Left as it was, the
-- bare `ALTER TABLE` would fail on a FRESH install ("no such table") and a failing plugin migration
-- drops the WHOLE plugin to OSS mode silently — which is why it is stripped rather than kept.
SELECT 1;
