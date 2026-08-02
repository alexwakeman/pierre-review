-- Postgres twin of migrations/0047_ml_comment_labels.sql — ML severity/category labels for
-- BOT-authored text (CORE, free tier, no LLM). HAND-WRITTEN ADDITIVE, like every pg migration
-- since 0023: never regenerate the baseline with `pnpm db:generate:pg`, which squashes it.
-- Index names are byte-identical to the sqlite twin (they are the drizzle index names).
CREATE TABLE IF NOT EXISTS "ml_comment_labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_id" integer NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" integer NOT NULL,
	"author_user_id" integer NOT NULL,
	"severity" text NOT NULL,
	"severity_ord" integer NOT NULL,
	"severity_prob" double precision NOT NULL,
	"categories" jsonb NOT NULL,
	"category_probs" jsonb NOT NULL,
	"is_summary" boolean NOT NULL,
	"backend" text NOT NULL,
	"model_version" text NOT NULL,
	"body_hash" text NOT NULL,
	"target_created_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ml_comment_labels" ADD CONSTRAINT "ml_comment_labels_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_comment_labels" ADD CONSTRAINT "ml_comment_labels_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_comment_labels" ADD CONSTRAINT "ml_comment_labels_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_comment_labels" ADD CONSTRAINT "ml_comment_labels_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcl_account_target" ON "ml_comment_labels" USING btree ("account_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcl_account_pr_idx" ON "ml_comment_labels" USING btree ("account_id","pr_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcl_account_repo_author_idx" ON "ml_comment_labels" USING btree ("account_id","repo_id","author_user_id");
