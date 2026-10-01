-- Postgres twin of migrations/0073_claude_review_chat.sql, where the contract lives. Claude Review
-- is local-only, so the table exists in Postgres for schema parity.
CREATE UNIQUE INDEX IF NOT EXISTS "claude_reviews_id_account" ON "claude_reviews" USING btree ("id","account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claude_review_chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"review_id" integer NOT NULL,
	"finding_id" integer,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"model" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_review_chat_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	CONSTRAINT "claude_review_chat_messages_finding_id_claude_review_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "claude_review_findings"("id") ON DELETE cascade,
	CONSTRAINT "crcm_review_account_fk" FOREIGN KEY ("review_id","account_id") REFERENCES "claude_reviews"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crcm_thread_idx" ON "claude_review_chat_messages" USING btree ("review_id","finding_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crcm_account_idx" ON "claude_review_chat_messages" USING btree ("account_id");
