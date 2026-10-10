-- REPORTS → THIS SPRINT — the Postgres twin of migrations/0100_sprint_stories.sql (read its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
CREATE TABLE IF NOT EXISTS "sprint_reads" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"provider" text,
	"source_json" jsonb,
	"read_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"next_read_at" timestamp with time zone NOT NULL,
	"error_code" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"viewed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sprint_reads_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprint_reads_account_workspace" ON "sprint_reads" USING btree ("account_id","workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sprint_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"ident" text NOT NULL,
	"provider" text NOT NULL,
	"api_root" text NOT NULL,
	"issue_key" text NOT NULL,
	"url" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"acceptance_criteria" text DEFAULT '' NOT NULL,
	"ac_field_id" text,
	"ac_field_name" text,
	"candidates_json" text,
	"omitted_candidates" integer DEFAULT 0 NOT NULL,
	"issue_type_id" text,
	"issue_type_name" text,
	"status_name" text,
	"status_category" text,
	"assignee_name" text,
	"assignee_avatar_url" text,
	"project_key" text,
	"epic_key" text,
	"epic_title" text,
	"components_json" text,
	"sprint_name" text,
	"in_sprint" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"issue_updated_at" timestamp with time zone,
	CONSTRAINT "sprint_tickets_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprint_tickets_account_ws_ident" ON "sprint_tickets" USING btree ("account_id","workspace_id","ident");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sprint_tickets_account_ident" ON "sprint_tickets" USING btree ("account_id","ident");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sprint_ticket_repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"ident" text NOT NULL,
	"repo_id" integer NOT NULL,
	"via" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sprint_ticket_repos_repo_account_fk" FOREIGN KEY ("repo_id","account_id") REFERENCES "repos"("id","account_id") ON DELETE cascade,
	CONSTRAINT "sprint_ticket_repos_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprint_ticket_repos_identity" ON "sprint_ticket_repos" USING btree ("account_id","workspace_id","ident","repo_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sprint_assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"ident" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"phase" text,
	"fingerprint" text NOT NULL,
	"text_hash" text NOT NULL,
	"repos_json" jsonb NOT NULL,
	"body_json" jsonb,
	"dropped_json" jsonb,
	"error" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "sprint_assessments_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sprint_assessments_account_ws_ident_idx" ON "sprint_assessments" USING btree ("account_id","workspace_id","ident","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracker_writes" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"ident" text NOT NULL,
	"provider" text NOT NULL,
	"request_id" text NOT NULL,
	"mode" text NOT NULL,
	"target_json" jsonb,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"url" text,
	"assessment_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tracker_writes_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tracker_writes_account_request" ON "tracker_writes" USING btree ("account_id","request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_writes_account_ident_idx" ON "tracker_writes" USING btree ("account_id","workspace_id","ident","created_at");
