-- Postgres twin of migrations/0080_ticket_reviews.sql, where the contract lives. Ticket review is
-- local-only, so the tables exist in Postgres for schema parity.
CREATE TABLE IF NOT EXISTS "ticket_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"ticket_ident" text NOT NULL,
	"ticket_key" text,
	"ticket_title" text,
	"ticket_snapshot" jsonb,
	"ticket_hash" text,
	"fingerprint" text,
	"pr_count" integer,
	"origin_pr_id" integer,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"error" text,
	"refused" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"alignment" text,
	"summary" text,
	"assessment" jsonb,
	CONSTRAINT "ticket_reviews_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tr_account_ident_created_idx" ON "ticket_reviews" USING btree ("account_id","ticket_ident","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tr_account_ws_created_idx" ON "ticket_reviews" USING btree ("account_id","workspace_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_reviews_id_account" ON "ticket_reviews" USING btree ("id","account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticket_review_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_review_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"head_sha" text NOT NULL,
	"pr_state" text NOT NULL,
	"checked_out" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ticket_review_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	CONSTRAINT "trm_review_account_fk" FOREIGN KEY ("ticket_review_id","account_id") REFERENCES "ticket_reviews"("id","account_id") ON DELETE cascade,
	CONSTRAINT "trm_pr_account_fk" FOREIGN KEY ("pr_id","account_id") REFERENCES "pull_requests"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trm_account_pr_idx" ON "ticket_review_members" USING btree ("account_id","pr_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trm_review_idx" ON "ticket_review_members" USING btree ("ticket_review_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticket_review_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_review_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"ref" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"owner_pr_id" integer,
	"path" text,
	"line" integer,
	"posted_pr_id" integer,
	"posted_comment_id" text,
	"posted_at" timestamp with time zone,
	"prior_item_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_review_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	CONSTRAINT "tri_review_account_fk" FOREIGN KEY ("ticket_review_id","account_id") REFERENCES "ticket_reviews"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tri_review_idx" ON "ticket_review_items" USING btree ("ticket_review_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tri_account_owner_idx" ON "ticket_review_items" USING btree ("account_id","owner_pr_id");
