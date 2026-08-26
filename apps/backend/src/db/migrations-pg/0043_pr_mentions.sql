-- Postgres twin of migrations/0056_pr_mentions.sql — "@you" on a PR, the MENTION arm of My
-- Turn's personal-relevance rule (CORE, no AI). HAND-WRITTEN ADDITIVE, like every pg migration
-- since 0023: never regenerate the baseline with `pnpm db:generate:pg`, which squashes it.
-- Index names are byte-identical to the sqlite twin (they are the drizzle index names).
CREATE TABLE IF NOT EXISTS "pr_mentions" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pr_mentions" ADD CONSTRAINT "pr_mentions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_mentions" ADD CONSTRAINT "pr_mentions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_mentions" ADD CONSTRAINT "pr_mentions_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prm_account_pr" ON "pr_mentions" USING btree ("account_id","pr_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prm_account_repo_idx" ON "pr_mentions" USING btree ("account_id","repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prm_pr_idx" ON "pr_mentions" USING btree ("pr_id");
