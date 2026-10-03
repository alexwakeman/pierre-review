-- USER-STORY RESULTS BECOME FINDINGS.
--
-- Every acceptance criterion a Claude Review judged not met / partly met, and every "Not done"
-- item of its user-story assessment, is now a normal row of claude_review_findings, made by the
-- server from the reconciled assessment (review/claude-review/ticket.ts `storyFindingsFrom`) — so
-- it posts, rewords, ignores and is followed up exactly like any other finding. The per-ticket
-- "Post as comment" is retired (an old row's stored `posted` record is ignored on read).
--
-- claude_review_findings.story_index (integer): the ticket's 0-based position on the run.
-- claude_review_findings.story_ref (text): the criterion's ref ('AC2') or a not-done item's ('M1').
-- Both NULL on an ordinary finding. Nullable, no backfill: older reviews keep their story results
-- in the stories section only.
-- The Postgres twin is migrations-pg/0066_claude_finding_story.sql.
ALTER TABLE `claude_review_findings` ADD `story_index` integer;
--> statement-breakpoint
ALTER TABLE `claude_review_findings` ADD `story_ref` text;
