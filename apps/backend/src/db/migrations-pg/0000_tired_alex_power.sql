CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"avatar_url" text,
	"access_token_enc" text,
	"is_local" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "accounts_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "claude_review_findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"review_id" integer NOT NULL,
	"path" text NOT NULL,
	"line" integer,
	"side" text DEFAULT 'RIGHT' NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"edited_body" text,
	"suggestion" text,
	"diff_hunk" text,
	"anchored" boolean DEFAULT true NOT NULL,
	"included" boolean DEFAULT false NOT NULL,
	"posted_at" timestamp with time zone,
	"github_comment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claude_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"head_sha" text NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"scope" text,
	"summary" text,
	"verdict" text,
	"user_body" text,
	"user_verdict" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"error" text,
	"excluded_files" jsonb,
	"posted_review_id" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "commit_files" (
	"sha" text PRIMARY KEY NOT NULL,
	"paths" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"id" serial PRIMARY KEY NOT NULL,
	"sha" text NOT NULL,
	"pr_id" integer NOT NULL,
	"author_id" integer,
	"committer_id" integer,
	"message" text,
	"committed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"actor_id" integer,
	"pr_id" integer,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ref_table" text,
	"ref_id" integer,
	"dedupe_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "my_turn_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"kind" text NOT NULL,
	"ref_id" integer NOT NULL,
	"dismissed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pr_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_node_id" text NOT NULL,
	"pr_id" integer NOT NULL,
	"author_id" integer,
	"body" text NOT NULL,
	"database_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pr_views" (
	"pr_id" integer PRIMARY KEY NOT NULL,
	"last_viewed_sha" text,
	"last_viewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_node_id" text NOT NULL,
	"account_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"author_id" integer,
	"merged_by_id" integer,
	"base_ref_name" text,
	"state" text NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"first_review_at" timestamp with time zone,
	"last_commit_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"head_sha" text,
	"ci_status" text,
	"mergeable" text,
	"merge_state_status" text,
	"labels" jsonb,
	"check_runs" jsonb
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"github_node_id" text NOT NULL,
	"default_branch" text,
	"backfill_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_node_id" text NOT NULL,
	"thread_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"author_id" integer,
	"body" text NOT NULL,
	"diff_hunk" text,
	"database_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"pr_id" integer NOT NULL,
	"user_id" integer,
	"team_name" text
);
--> statement-breakpoint
CREATE TABLE "review_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_node_id" text NOT NULL,
	"pr_id" integer NOT NULL,
	"path" text NOT NULL,
	"line" integer,
	"is_resolved" boolean NOT NULL,
	"is_outdated" boolean DEFAULT false NOT NULL,
	"derived_state" text NOT NULL,
	"original_commenter_id" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_node_id" text NOT NULL,
	"pr_id" integer NOT NULL,
	"author_id" integer,
	"state" text NOT NULL,
	"body" text,
	"database_id" text,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"repo_id" integer PRIMARY KEY NOT NULL,
	"last_full_sync_at" timestamp with time zone,
	"last_incremental_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_login" text NOT NULL,
	"github_node_id" text,
	"display_name" text,
	"avatar_url" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"is_bot_overridden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_github_login_unique" UNIQUE("github_login"),
	CONSTRAINT "users_github_node_id_unique" UNIQUE("github_node_id")
);
--> statement-breakpoint
ALTER TABLE "claude_review_findings" ADD CONSTRAINT "claude_review_findings_review_id_claude_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."claude_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claude_reviews" ADD CONSTRAINT "claude_reviews_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claude_reviews" ADD CONSTRAINT "claude_reviews_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_committer_id_users_id_fk" FOREIGN KEY ("committer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "my_turn_dismissals" ADD CONSTRAINT "my_turn_dismissals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_comments" ADD CONSTRAINT "pr_comments_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_comments" ADD CONSTRAINT "pr_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_views" ADD CONSTRAINT "pr_views_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_merged_by_id_users_id_fk" FOREIGN KEY ("merged_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_thread_id_review_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."review_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_original_commenter_id_users_id_fk" FOREIGN KEY ("original_commenter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crf_review_idx" ON "claude_review_findings" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "cr_pr_idx" ON "claude_reviews" USING btree ("pr_id");--> statement-breakpoint
CREATE INDEX "cr_pr_sha_idx" ON "claude_reviews" USING btree ("pr_id","head_sha");--> statement-breakpoint
CREATE INDEX "cr_account_idx" ON "claude_reviews" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "commit_pr_idx" ON "commits" USING btree ("pr_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commit_sha_pr_ux" ON "commits" USING btree ("sha","pr_id");--> statement-breakpoint
CREATE INDEX "events_time_idx" ON "events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "events_repo_time_idx" ON "events" USING btree ("repo_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "events_account_idx" ON "events" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_account_dedupe" ON "events" USING btree ("account_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mtd_kind_ref_ux" ON "my_turn_dismissals" USING btree ("kind","ref_id");--> statement-breakpoint
CREATE INDEX "mtd_account_idx" ON "my_turn_dismissals" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "prc_pr_idx" ON "pr_comments" USING btree ("pr_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prc_pr_node" ON "pr_comments" USING btree ("pr_id","github_node_id");--> statement-breakpoint
CREATE INDEX "pr_repo_idx" ON "pull_requests" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "pr_opened_idx" ON "pull_requests" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "pr_account_idx" ON "pull_requests" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_account_node" ON "pull_requests" USING btree ("account_id","github_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_account_owner_name" ON "repos" USING btree ("account_id","owner","name");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_account_node" ON "repos" USING btree ("account_id","github_node_id");--> statement-breakpoint
CREATE INDEX "repos_account_idx" ON "repos" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "rc_thread_idx" ON "review_comments" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rc_pr_node" ON "review_comments" USING btree ("pr_id","github_node_id");--> statement-breakpoint
CREATE INDEX "rr_pr_idx" ON "review_requests" USING btree ("pr_id");--> statement-breakpoint
CREATE INDEX "rr_user_idx" ON "review_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thread_pr_idx" ON "review_threads" USING btree ("pr_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_pr_node" ON "review_threads" USING btree ("pr_id","github_node_id");--> statement-breakpoint
CREATE INDEX "rv_pr_idx" ON "reviews" USING btree ("pr_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_pr_node" ON "reviews" USING btree ("pr_id","github_node_id");