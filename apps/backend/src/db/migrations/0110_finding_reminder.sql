-- CLAUDE REVIEW → REMINDERS (2026-10-14; docs/CLAUDE-REVIEW.md § Auto-posting, "Reminders"). The
-- Postgres twin is migrations-pg/0097_finding_reminder.sql.
--
--   claude_review_findings.reminder  JSON ClaudeFindingReminder — the latest "Post reminder" a person
--   posted of an already-posted finding (comment id, kind, when). NULL = none. Never the finding's
--   own post: posted_at / github_comment_id are untouched.
ALTER TABLE `claude_review_findings` ADD `reminder` text;
