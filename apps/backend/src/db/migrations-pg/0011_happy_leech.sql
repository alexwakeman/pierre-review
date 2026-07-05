CREATE TABLE "ci_status_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"head_sha" text NOT NULL,
	"status" text NOT NULL,
	"failing_checks" jsonb,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ci_status_events" ADD CONSTRAINT "ci_status_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_status_events" ADD CONSTRAINT "ci_status_events_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_status_events" ADD CONSTRAINT "ci_status_events_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cse_account_pr_observed" ON "ci_status_events" USING btree ("account_id","pr_id","observed_at");--> statement-breakpoint
CREATE INDEX "cse_account_repo_observed" ON "ci_status_events" USING btree ("account_id","repo_id","observed_at");