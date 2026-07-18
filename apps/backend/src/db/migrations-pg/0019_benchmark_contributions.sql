ALTER TABLE "accounts" ADD COLUMN "benchmark_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "benchmark_contributions" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"vendor_kind" text NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"threads" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"acted_on" integer DEFAULT 0 NOT NULL,
	"untouched" integer DEFAULT 0 NOT NULL,
	"human_follow" integer DEFAULT 0 NOT NULL,
	"oldest_untouched_days" integer,
	"org_size_bucket" text NOT NULL,
	"ml_metrics" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benchmark_contributions" ADD CONSTRAINT "benchmark_contributions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bench_contrib_uniq" ON "benchmark_contributions" USING btree ("account_id","vendor_kind","week_start");--> statement-breakpoint
CREATE INDEX "bench_contrib_account_idx" ON "benchmark_contributions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "bench_contrib_cohort_idx" ON "benchmark_contributions" USING btree ("vendor_kind","week_start");
