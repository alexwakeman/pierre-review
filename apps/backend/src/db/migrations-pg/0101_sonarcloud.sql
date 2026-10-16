-- SONARCLOUD (2026-10-16). Twin of migrations/0114_sonarcloud.sql, where the contract lives.
CREATE TABLE IF NOT EXISTS "workspace_sonar" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"organization" text,
	"auth_token" text,
	"project_keys" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sonar_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_sonar_account_workspace" ON "workspace_sonar" USING btree ("account_id","workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sonar_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"head_sha" text NOT NULL,
	"state" text NOT NULL,
	"message" text,
	"project_key" text,
	"quality_gate" jsonb,
	"issues" jsonb,
	"total_issues" integer DEFAULT 0 NOT NULL,
	"total_hotspots" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"post" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sonar_snapshots_account_pr_head" ON "sonar_snapshots" USING btree ("account_id","pr_id","head_sha");
