-- CLAUDE REVIEW: FOLLOW-UP ON THE PREVIOUS REVIEW + THE OPTIONAL USER STORY (local-only feature).
--
-- claude_reviews.ticket: the user story or task the run was given ({title, description,
-- acceptanceCriteria, criteria[]}, criteria = the server's AC1..n split). Written at QUEUE time,
-- so a failed or cancelled run still prefills the panel on the next run.
-- claude_reviews.ticket_assessment: the server-validated assessment against it (each criterion
-- answered exactly once; one Claude skipped is 'not_checked').
-- claude_reviews.follow_up: what this run found about the PREVIOUS succeeded review's findings
-- (addressed / partly / not / no longer applies / not checked) + that review's id and head.
-- claude_review_findings.prior_finding_id: the previous-review finding this one RE-RAISES. A SOFT
-- reference with NO FK: it always points at a finding of the SAME PR, and retention.ts +
-- deleteRepo delete a PR's findings in one statement, so an FK would only add delete-ordering risk.
--
-- All four are nullable with no backfill: an older run simply has none of them.
-- The Postgres twin is migrations-pg/0057_claude_review_follow_up_ticket.sql.
ALTER TABLE `claude_reviews` ADD `ticket` text;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `ticket_assessment` text;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `follow_up` text;
--> statement-breakpoint
ALTER TABLE `claude_review_findings` ADD `prior_finding_id` integer;
