-- Postgres twin of migrations/0063_repo_file_coupling.sql — the per-repo co-change index behind
-- the blast-radius hub arm. See the sqlite original for what it stores, why it stores only the
-- hubs, and why `hub_bar` is max(repo p90, an absolute floor) rather than either alone.
CREATE TABLE IF NOT EXISTS "repo_file_coupling" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL REFERENCES "accounts"("id"),
	"repo_id" integer NOT NULL REFERENCES "repos"("id"),
	"hub_bar" integer NOT NULL,
	"pr_count" integer NOT NULL,
	"hubs" jsonb NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "rfc_account_repo" ON "repo_file_coupling" ("account_id","repo_id");
