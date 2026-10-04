-- Postgres twin of migrations/0081_review_request_requester.sql — who asked for a review
-- (`review_request_events.requester_user_id`) plus the one-time re-read of OPEN PRs' history
-- through the existing backfill. See the sqlite original for the rationale.
ALTER TABLE "review_request_events" ADD COLUMN IF NOT EXISTS "requester_user_id" integer
  REFERENCES "users"("id");
UPDATE "pull_requests" SET "review_requests_synced_at" = NULL
WHERE "state" = 'open'
  AND "review_requests_synced_at" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "review_request_events" e
    WHERE e."pr_id" = "pull_requests"."id"
      AND e."kind" = 'requested'
      AND e."requester_user_id" IS NULL
  );
