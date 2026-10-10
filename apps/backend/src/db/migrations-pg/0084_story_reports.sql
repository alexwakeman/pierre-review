-- THE STORY REPORT — the Postgres twin of migrations/0097_story_reports.sql (read its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
CREATE TABLE IF NOT EXISTS "story_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"window_choice" text NOT NULL,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone NOT NULL,
	"range_json" jsonb NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"fingerprint" text NOT NULL,
	"picked_json" jsonb NOT NULL,
	"population_json" jsonb NOT NULL,
	"report_json" jsonb,
	"dropped_json" jsonb,
	"error" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "story_reports_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "story_reports_account_ws_window_idx" ON "story_reports" USING btree ("account_id","workspace_id","window_choice","created_at");
