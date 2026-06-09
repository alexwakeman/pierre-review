-- Claude Review findings are now INCLUDED by default (the UI is opt-OUT via an
-- "Ignore" button, replacing the old opt-IN "include" checkbox). New findings are
-- inserted with included=1 (see review/persist.ts); this backfills existing rows so
-- already-generated reviews show their findings as included rather than ignored.
-- SQLite-only: Claude Review is force-disabled in cloud, so the Postgres
-- claude_review_findings table is never populated.
UPDATE `claude_review_findings` SET `included` = 1 WHERE `included` = 0;
