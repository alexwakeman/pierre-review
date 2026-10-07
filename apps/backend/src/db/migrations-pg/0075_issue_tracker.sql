-- Postgres twin of migrations/0088_issue_tracker.sql: the issue tracker moves to CORE
-- (apiVersion 23). `workspace_trackers` and `tracker_tickets` are new; `pro_jira_ac_fields` is
-- ADOPTED IN PLACE (the plugin's pg 0038 shape, same index name). No data is copied here — the
-- boot-time move (src/tracker/legacy-import.ts) does that, guarded on the plugin tables existing.
-- Rationale in the sqlite twin and docs/TRACKERS.md.
CREATE TABLE IF NOT EXISTS "workspace_trackers" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"provider" text,
	"base_url" text,
	"project_keys" text,
	"match_scope" text,
	"auth_email" text,
	"auth_token" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_trackers_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_trackers_account_workspace" ON "workspace_trackers" USING btree ("account_id","workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracker_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"provider" text DEFAULT 'jira' NOT NULL,
	"issue_key" text NOT NULL,
	"detected_from" text NOT NULL,
	"detect_order" integer NOT NULL,
	"api_root" text NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"error_code" text,
	"title" text,
	"description" text,
	"acceptance_criteria" text,
	"ac_field_id" text,
	"ac_field_name" text,
	"ac_field_source" text,
	"issue_type_id" text,
	"issue_type_name" text,
	"status_name" text,
	"status_category" text,
	"assignee_name" text,
	"assignee_account_id" text,
	"assignee_avatar_url" text,
	"candidates_json" text,
	"omitted_candidates" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tracker_tickets_account_pr_key" ON "tracker_tickets" USING btree ("account_id","pr_id","issue_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_tickets_account_ws_type" ON "tracker_tickets" USING btree ("account_id","workspace_id","issue_type_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_tickets_account_site_key" ON "tracker_tickets" USING btree ("account_id","provider","api_root","issue_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_tickets_account_changed" ON "tracker_tickets" USING btree ("account_id","changed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_tickets_pr" ON "tracker_tickets" USING btree ("pr_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pro_jira_ac_fields" (
	"id" serial PRIMARY KEY,
	"account_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"api_root" text NOT NULL,
	"issue_type_id" text NOT NULL,
	"field_id" text NOT NULL,
	"field_name" text NOT NULL,
	"updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pro_jira_ac_fields_account_ws_site_type" ON "pro_jira_ac_fields" ("account_id","workspace_id","api_root","issue_type_id");
