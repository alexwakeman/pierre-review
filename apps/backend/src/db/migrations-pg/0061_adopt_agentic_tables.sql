-- ADOPT THE AGENTIC TABLES INTO CORE — the Postgres twin of
-- migrations/0074_adopt_agentic_tables.sql, where the contract lives. Every statement is
-- replay-safe (IF NOT EXISTS), so an install where the plugin already created the tables adopts
-- them in place. Unlike SQLite, Postgres can add the comments-seed columns idempotently, so an
-- adopted ai_fixes that predates plugin 0024 is brought up to shape here too.
CREATE TABLE IF NOT EXISTS "review_learnings" (
	"id" serial PRIMARY KEY,
	"account_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"source_review_id" integer NOT NULL,
	"finding_id" integer,
	"head_sha" text NOT NULL,
	"kind" text NOT NULL,
	"path" text,
	"dir_path" text,
	"ext" text,
	"category" text,
	"claude_verdict" text,
	"user_verdict" text,
	"claude_title" text,
	"claude_text" text,
	"user_text" text,
	"posted_comment_kind" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rl_account_dedupe" ON "review_learnings" ("account_id","dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rl_account_repo_category" ON "review_learnings" ("account_id","repo_id","category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rl_account_repo_dir" ON "review_learnings" ("account_id","repo_id","dir_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rl_account_source_review" ON "review_learnings" ("account_id","source_review_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rl_account_repo_created" ON "review_learnings" ("account_id","repo_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_fixes" (
	"id" serial PRIMARY KEY,
	"account_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"source_review_id" integer,
	"base_sha" text NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"seed" text NOT NULL,
	"prompt" text,
	"summary" text,
	"commit_message" text,
	"patch" text,
	"files_changed" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"error" text,
	"pushed_branch" text,
	"pushed_pr_number" integer,
	"pushed_pr_url" text,
	"pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"comment_targets" text,
	"comment_verdicts" text
);
--> statement-breakpoint
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "comment_targets" text;
--> statement-breakpoint
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "comment_verdicts" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "af_account_pr_created" ON "ai_fixes" ("account_id","pr_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "af_account_status" ON "ai_fixes" ("account_id","status");
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_review_enabled" boolean;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "auto_review_enabled_at" timestamp with time zone;
