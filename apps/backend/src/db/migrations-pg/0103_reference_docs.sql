-- REFERENCE DOCS (2026-10-16). Twin of migrations/0116_reference_docs.sql, where the contract lives.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "docs_in_review" boolean;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reference_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"stage" text,
	"error" text,
	"section_count" integer DEFAULT 0 NOT NULL,
	"sections" jsonb,
	"summary" text,
	"topics" jsonb,
	"page_count" integer,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"build_started_at" timestamp with time zone,
	"built_at" timestamp with time zone,
	CONSTRAINT "reference_docs_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reference_docs_workspace_slug" ON "reference_docs" USING btree ("account_id","workspace_id","slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reference_doc_chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"workspace_id" integer NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_doc_chat_workspace_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "workspaces"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reference_doc_chat_conversation" ON "reference_doc_chat_messages" USING btree ("account_id","workspace_id","conversation_id");
