CREATE TABLE "bot_mute_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"vendor_kind" text,
	"path_glob" text,
	"severity" text,
	"action" text NOT NULL,
	"auto_resolve_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_review_classification" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"author_user_id" integer NOT NULL,
	"automated" boolean NOT NULL,
	"kind" text,
	"label" text,
	"confidence" text NOT NULL,
	"source" text NOT NULL,
	"reasons_json" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_type" text;--> statement-breakpoint
ALTER TABLE "bot_mute_rules" ADD CONSTRAINT "bot_mute_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_review_classification" ADD CONSTRAINT "bot_review_classification_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_review_classification" ADD CONSTRAINT "bot_review_classification_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bmr_account_idx" ON "bot_mute_rules" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brc_account_author" ON "bot_review_classification" USING btree ("account_id","author_user_id");