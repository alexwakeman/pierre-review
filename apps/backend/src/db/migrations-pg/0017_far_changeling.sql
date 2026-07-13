CREATE TABLE "team_repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_repos" ADD CONSTRAINT "team_repos_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_repos" ADD CONSTRAINT "team_repos_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_repos" ADD CONSTRAINT "team_repos_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_repos_team_repo" ON "team_repos" USING btree ("team_id","repo_id");--> statement-breakpoint
CREATE INDEX "team_repos_account_idx" ON "team_repos" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "team_repos_repo_idx" ON "team_repos" USING btree ("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_account_name" ON "teams" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX "teams_account_idx" ON "teams" USING btree ("account_id");