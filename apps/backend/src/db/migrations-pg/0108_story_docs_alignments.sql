-- CHECK A STORY AGAINST THE DOCS — the Postgres twin of migrations/0121_story_docs_alignments.sql
-- (read its header). ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
CREATE TABLE IF NOT EXISTS "story_docs_alignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"ident" text NOT NULL,
	"ticket_key" text,
	"status" text NOT NULL,
	"fingerprint" text NOT NULL,
	"story_hash" text NOT NULL,
	"criteria_hash" text NOT NULL,
	"library_hash" text NOT NULL,
	"version" integer NOT NULL,
	"criteria_source" text NOT NULL,
	"criteria_json" jsonb,
	"shortlist_json" jsonb,
	"result_json" jsonb,
	"error" text,
	"shortlist_model" text,
	"model" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "story_docs_alignments_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "story_docs_alignments_subject_idx" ON "story_docs_alignments" USING btree ("account_id","workspace_id","ident","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "story_docs_alignments_account_created" ON "story_docs_alignments" USING btree ("account_id","created_at");
