CREATE TABLE "ai_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"seam" text NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" double precision NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"pr_id" integer,
	"repo_id" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "au_account_occurred" ON "ai_usage" USING btree ("account_id","occurred_at");