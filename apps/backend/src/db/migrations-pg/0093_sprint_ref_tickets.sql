-- REPORTS → THIS SPRINT — the Postgres twin of migrations/0106_sprint_ref_tickets.sql (read its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
CREATE TABLE IF NOT EXISTS "sprint_ref_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"ident" text NOT NULL,
	"provider" text NOT NULL,
	"api_root" text NOT NULL,
	"issue_key" text NOT NULL,
	"title" text,
	"status_name" text,
	"status_category" text,
	"url" text,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sprint_ref_tickets_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprint_ref_tickets_account_ws_ident" ON "sprint_ref_tickets" USING btree ("account_id","workspace_id","ident");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sprint_ref_tickets_account_key" ON "sprint_ref_tickets" USING btree ("account_id","issue_key");
