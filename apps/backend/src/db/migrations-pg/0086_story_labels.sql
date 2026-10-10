-- STORY LABELS — the Postgres twin of migrations/0099_story_labels.sql (read its header).
-- ⚠ NOT REPLAYED on a real Postgres (docs/MIGRATIONS.md § Known gaps).
CREATE TABLE IF NOT EXISTS "story_labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"ident" text NOT NULL,
	"text_hash" text NOT NULL,
	"rubric_version" integer NOT NULL,
	"criteria_json" jsonb NOT NULL,
	"story_json" jsonb NOT NULL,
	"criteria_count" integer NOT NULL,
	"model" text NOT NULL,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "story_labels_identity_ux" ON "story_labels" USING btree ("account_id","ident","rubric_version","text_hash");
