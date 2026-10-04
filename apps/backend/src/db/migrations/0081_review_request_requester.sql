-- WHO ASKED FOR A REVIEW — `review_request_events.requester_user_id`, the ReviewRequestedEvent's
-- `actor`. Read by the Pending my_turn review_request card's heading ("Robin asked you to
-- review"). NULL = not known (a row written before this migration, a ghost actor, a removal event).
--
-- The ONE-TIME FILL rides the existing review-request history backfill
-- (sync/backfill-review-requests.ts), never a new fetch path: the stamp is cleared for OPEN PRs
-- whose request rows lack a requester, so the backfill's open-PR worklist re-reads each ONCE (it
-- re-stamps on receipt, so a ghost actor cannot loop). Merged/closed PRs are left alone — no card
-- reads them. Until the re-read lands Chronology reads those open PRs as "not known", which is the
-- truth about a history we are about to re-receive. The Postgres twin is
-- migrations-pg/0068_review_request_requester.sql.
ALTER TABLE `review_request_events` ADD `requester_user_id` integer REFERENCES `users`(`id`);
--> statement-breakpoint
UPDATE `pull_requests` SET `review_requests_synced_at` = NULL
WHERE `state` = 'open'
  AND `review_requests_synced_at` IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM `review_request_events` e
    WHERE e.`pr_id` = `pull_requests`.`id`
      AND e.`kind` = 'requested'
      AND e.`requester_user_id` IS NULL
  );
