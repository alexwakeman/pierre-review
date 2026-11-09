-- A DISMISSED REVIEW'S DISMISSAL (2026-11-09; docs/TEAM-REVIEW.md § When Limn takes its approval back).
-- CORE, additive. GitHub's reviews API reports a dismissed review only as `DISMISSED`; WHEN, BY WHOM and
-- WHY live on the PR timeline's ReviewDismissedEvent, which the PR walk now reads (`reviewDismissals`).
--
--   reviews.dismissed_at            when it was dismissed (the event's createdAt). NULL = no dismissal seen.
--   reviews.dismissed_by_user_id    who dismissed it (the Limn bot for a "Limn withdrew…" dismissal).
--   reviews.dismissal_message       GitHub's dismissal message, verbatim.
-- Set only from a received event; never cleared (a dismissal cannot be undone on GitHub). The same
-- event is also an `events` row, type 'review_dismissed', dedupeKey `review_dismissed:<event node id>`.
ALTER TABLE `reviews` ADD COLUMN `dismissed_at` integer;
--> statement-breakpoint
ALTER TABLE `reviews` ADD COLUMN `dismissed_by_user_id` integer REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `reviews` ADD COLUMN `dismissal_message` text;
