-- CLAUDE REVIEW: OTHER REVIEWERS' THREADS, AND THE COMMENT HALF OF THE AUTO RE-REVIEW KEY.
--
-- claude_reviews.thread_assessments (JSON array): every OTHER open review thread on the PR when the
-- run loaded it — comments from people and from other review bots, never Limn's own posted
-- findings (the follow-up covers those) — with Claude's two answers per thread: is the comment
-- right (valid / partly_valid / not_valid / unclear) and has the code dealt with it (addressed /
-- partly_addressed / not_addressed / unclear), plus 'not_checked' written only by the server.
-- NULL on every older row (the wire reads it as "did not assess threads"; no backfill).
--
-- claude_reviews.comments_through (unix seconds): the newest qualifying review-thread comment the
-- run saw. The auto-review sweeper re-reviews the same head when a newer one arrives (after the
-- same 5-minute settle as a moved head). NULL ⇒ the row's created_at stands in, so a deploy does
-- not re-review every PR that already has comments.
-- The Postgres twin is migrations-pg/0063_claude_review_threads.sql.
ALTER TABLE `claude_reviews` ADD `thread_assessments` text;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `comments_through` integer;
