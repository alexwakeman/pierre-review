-- WORKSPACE SETTINGS HISTORY — the Postgres twin of migrations/0096_workspace_setting_events.sql
-- (read that file for the rationale). Additive, append-only, going forward only.
CREATE TABLE IF NOT EXISTS "workspace_setting_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_setting_events_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_setting_events_account_ws_time_idx" ON "workspace_setting_events" USING btree ("account_id","workspace_id","occurred_at");
