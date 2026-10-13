-- REPORTS → THIS SPRINT AS A GRAPH — the Postgres twin of migrations/0107_sprint_graph.sql (read its
-- header). ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
ALTER TABLE "sprint_ref_tickets" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "sprint_ref_tickets" ADD COLUMN IF NOT EXISTS "acceptance_criteria" text;
--> statement-breakpoint
ALTER TABLE "sprint_ref_tickets" ADD COLUMN IF NOT EXISTS "issue_type_name" text;
--> statement-breakpoint
ALTER TABLE "sprint_ref_tickets" ADD COLUMN IF NOT EXISTS "assignee_name" text;
--> statement-breakpoint
ALTER TABLE "sprint_ref_tickets" ADD COLUMN IF NOT EXISTS "assignee_avatar_url" text;
--> statement-breakpoint
ALTER TABLE "sprint_ref_tickets" ADD COLUMN IF NOT EXISTS "blocked_by_json" jsonb;
--> statement-breakpoint
ALTER TABLE "sprint_ref_tickets" ADD COLUMN IF NOT EXISTS "depth" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sprint_briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"ident" text NOT NULL,
	"text_hash" text NOT NULL,
	"brief_version" integer NOT NULL,
	"summary" text NOT NULL,
	"criteria_json" jsonb NOT NULL,
	"criteria_derived" boolean DEFAULT false NOT NULL,
	"references_json" jsonb NOT NULL,
	"model" text NOT NULL,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprint_briefs_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprint_briefs_account_ws_ident" ON "sprint_briefs" USING btree ("account_id","workspace_id","ident");
--> statement-breakpoint
DROP TABLE IF EXISTS "tracker_writes";
