-- Postgres twin of migrations/0086_ticket_review_pr_cards.sql: ticket review contribution cards,
-- one row per (account, PR, head commit). The contract lives in schema.sqlite.ts.
CREATE TABLE IF NOT EXISTS "ticket_review_pr_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"head_sha" text NOT NULL,
	"card" jsonb NOT NULL,
	"source" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_review_pr_cards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	CONSTRAINT "trpc_pr_account_fk" FOREIGN KEY ("pr_id","account_id") REFERENCES "pull_requests"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trpc_account_pr_head_ux" ON "ticket_review_pr_cards" USING btree ("account_id","pr_id","head_sha");
