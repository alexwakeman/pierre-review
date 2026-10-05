-- Postgres twin of migrations/0082_ci_reviews.sql, where the contract lives. CI review is
-- local-only, so the tables exist in Postgres for schema parity. `job_id` is BIGINT: GitHub Actions
-- job ids have passed 2^31.
CREATE TABLE IF NOT EXISTS "ci_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"head_sha" text NOT NULL,
	"failing_key" text,
	"trigger_key" text,
	"failing_checks" jsonb,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"error" text,
	"refused" text,
	"ci_state" jsonb,
	"summary" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_reviews_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	CONSTRAINT "cir_pr_account_fk" FOREIGN KEY ("pr_id","account_id") REFERENCES "pull_requests"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cir_account_pr_created_idx" ON "ci_reviews" USING btree ("account_id","pr_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cir_account_ws_created_idx" ON "ci_reviews" USING btree ("account_id","workspace_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ci_reviews_id_account" ON "ci_reviews" USING btree ("id","account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ci_review_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"ci_review_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"ref" text,
	"check_name" text NOT NULL,
	"job_id" bigint,
	"step" text,
	"url" text,
	"sent" boolean DEFAULT false NOT NULL,
	"carried" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"not_checked_reason" text,
	"cause" text,
	"explanation" text,
	"category" text,
	"fixable_in_pr" boolean,
	"path" text,
	"line" integer,
	"suggestion" text,
	"related_files" jsonb,
	"assessed_at_head" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_review_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	CONSTRAINT "ciri_review_account_fk" FOREIGN KEY ("ci_review_id","account_id") REFERENCES "ci_reviews"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ciri_review_idx" ON "ci_review_items" USING btree ("ci_review_id");
