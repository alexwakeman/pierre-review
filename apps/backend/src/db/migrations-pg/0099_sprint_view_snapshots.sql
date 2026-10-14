-- ACTIVITY → THIS SPRINT: "SINCE YOU LAST LOOKED" — the Postgres twin of
-- migrations/0112_sprint_view_snapshots.sql (read its header). ⚠ NOT REPLAYED on a real Postgres
-- (docs/MIGRATIONS.md § Known gaps).
CREATE TABLE IF NOT EXISTS "sprint_view_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"current_json" jsonb NOT NULL,
	"current_at" timestamp with time zone NOT NULL,
	"baseline_json" jsonb,
	"baseline_at" timestamp with time zone,
	CONSTRAINT "sprint_view_snapshots_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprint_view_snapshots_account_ws" ON "sprint_view_snapshots" USING btree ("account_id","workspace_id");
