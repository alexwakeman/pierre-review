-- ACTIVITY → THIS SPRINT: the SPRINT BUILDER's critical paths — the Postgres twin of
-- migrations/0120_sprint_paths.sql (read its header). ⚠ NOT REPLAYED on a real Postgres
-- (docs/MIGRATIONS.md § Known gaps).
CREATE TABLE IF NOT EXISTS "sprint_paths" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"input_hash" text,
	"paths_version" integer,
	"paths_json" jsonb,
	"model" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"written_at" timestamp with time zone,
	"attempt_at" timestamp with time zone,
	"attempt_hash" text,
	"attempt_error" text,
	"runs_day" text,
	"runs_today" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprint_paths_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprint_paths_account_ws" ON "sprint_paths" USING btree ("account_id","workspace_id");
