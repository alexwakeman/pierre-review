-- Postgres twin of migrations/0058_pending_mute.sql — THE PENDING MUTE (CORE, free, no AI).
-- HAND-WRITTEN ADDITIVE, like every pg migration since 0023: never regenerate the baseline with
-- `pnpm db:generate:pg`, which squashes it. Index and constraint names are byte-identical to the
-- sqlite twin (they are the drizzle names).
--
-- Read the sqlite twin for the full argument. The three things that will otherwise be re-litigated:
--   • a mute is NOT the `repos.inbox_watch` visibility axis migration 0046 dropped — no screen's
--     population changes, only whether a row may CLAIM THE READER'S TURN and interrupt them;
--   • the workspace flag and the repo rows are TWO INDEPENDENT FACTS, OR-ed, never a fallback
--     chain (`null`-means-inherit is a named bug class here);
--   • `pending_muted_repos` carries no `workspace_id` on purpose — a repo belongs to exactly one
--     workspace already, and a fact lives at exactly one grain.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "pending_muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_muted_repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_muted_repos_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
	-- The composite tenancy FK, declared INLINE like workspace_repos' pair in pg 0031: `repo_id`
	-- arrives in a request body, so the PAIR is what must exist. It leans on the
	-- `repos_id_account` unique index, which exists for exactly this purpose.
	CONSTRAINT "pending_muted_repos_repo_account_fk" FOREIGN KEY ("repo_id","account_id") REFERENCES "repos"("id","account_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pending_muted_repos_account_repo" ON "pending_muted_repos" USING btree ("account_id","repo_id");
