-- REPORTS → THIS SPRINT: the graph's THEMES — the Postgres twin of migrations/0108_sprint_themes.sql
-- (read its header). ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
CREATE TABLE IF NOT EXISTS "sprint_themes" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"input_hash" text NOT NULL,
	"theme_version" integer NOT NULL,
	"themes_json" jsonb NOT NULL,
	"assignments_json" jsonb NOT NULL,
	"model" text NOT NULL,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprint_themes_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprint_themes_account_ws" ON "sprint_themes" USING btree ("account_id","workspace_id");
