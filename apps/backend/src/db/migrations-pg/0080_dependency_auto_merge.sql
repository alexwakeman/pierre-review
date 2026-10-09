-- DEPENDENCY AUTO-MERGE — the Postgres twin of migrations/0093_dependency_auto_merge.sql (read that
-- file for the rationale). Additive.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "dependency_auto_merge" boolean;
--> statement-breakpoint
ALTER TABLE "auto_merge_requests" ADD COLUMN IF NOT EXISTS "armed_by_policy" boolean;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auto_merge_policy_skips" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_merge_policy_skips_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	CONSTRAINT "amps_pr_account_fk" FOREIGN KEY ("pr_id","account_id") REFERENCES "pull_requests"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "amps_account_pr" ON "auto_merge_policy_skips" USING btree ("account_id","pr_id");
