-- CHECK THREADS — the Postgres twin of migrations/0122_claude_thread_checks.sql (read its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
CREATE TABLE IF NOT EXISTS "claude_thread_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"head_sha" text NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"threads_sent" integer,
	"thread_assessments" jsonb,
	"comments_through" timestamp with time zone,
	"refused" text,
	"error" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_thread_checks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	CONSTRAINT "ctc_pr_account_fk" FOREIGN KEY ("pr_id","account_id") REFERENCES "pull_requests"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ctc_account_pr_created_idx" ON "claude_thread_checks" USING btree ("account_id","pr_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ctc_account_ws_created_idx" ON "claude_thread_checks" USING btree ("account_id","workspace_id","created_at");
