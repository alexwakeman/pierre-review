-- Postgres twin of migrations/0066_review_request_events.sql — the review-request HISTORY (every
-- requested / removed event from a PR's timeline) plus the per-PR "history received" stamp. See
-- the sqlite original for why the table carries no account_id, why it is immutable, and why NULL
-- in the stamp means "not known" rather than "never requested".
CREATE TABLE IF NOT EXISTS "review_request_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"pr_id" integer NOT NULL,
	"github_node_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reviewer_kind" text NOT NULL,
	"reviewer_user_id" integer,
	"team_slug" text,
	CONSTRAINT "review_request_events_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "pull_requests"("id"),
	CONSTRAINT "review_request_events_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "review_request_events_pr_node" ON "review_request_events" ("pr_id","github_node_id");
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "review_requests_synced_at" timestamp with time zone;
