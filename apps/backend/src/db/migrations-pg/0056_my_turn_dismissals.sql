-- MY TURN DISMISSALS — the Postgres twin of migrations/0069_my_turn_dismissals.sql. Read that
-- header for the contract (and 0047/0060 for why the previous table of this name was dropped).
--
-- `pull_requests_id_account` is the parent key of the composite tenancy FK below, the
-- `repos_id_account` trick; Postgres accepts a plain unique index there.
CREATE UNIQUE INDEX IF NOT EXISTS "pull_requests_id_account" ON "pull_requests" USING btree ("id","account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "my_turn_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"pr_id" integer,
	"repo_id" integer,
	"dismissed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "my_turn_dismissals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	CONSTRAINT "my_turn_dismissals_pr_account_fk" FOREIGN KEY ("pr_id","account_id") REFERENCES "pull_requests"("id","account_id") ON DELETE cascade,
	CONSTRAINT "my_turn_dismissals_repo_account_fk" FOREIGN KEY ("repo_id","account_id") REFERENCES "repos"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "my_turn_dismissals_account_pr" ON "my_turn_dismissals" USING btree ("account_id","pr_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "my_turn_dismissals_account_repo" ON "my_turn_dismissals" USING btree ("account_id","repo_id");
