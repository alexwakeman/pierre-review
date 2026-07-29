-- Default-branch status ("is trunk green?") — the Postgres twin of the sqlite migration
-- 0039_branch_status. See that file for the full rationale: four nullable snapshot columns on
-- `repos` (kept separate from the existing `default_branch` name column so the two syncs can't
-- clobber each other) plus `branch_commits`, which is NOT derivable from the PR-scoped
-- `commits` table. FKs CASCADE so a repo delete / account erasure cleans up automatically.
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "default_branch_name" text;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "default_branch_head_sha" text;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "default_branch_ci_status" text;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "default_branch_updated_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branch_commits" (
  "id" serial PRIMARY KEY NOT NULL,
  "account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "repo_id" integer NOT NULL REFERENCES "repos"("id") ON DELETE cascade,
  "sha" text NOT NULL,
  "message_headline" text NOT NULL,
  "author_user_id" integer REFERENCES "users"("id"),
  "author_name" text,
  "author_avatar_url" text,
  "committed_at" timestamp with time zone NOT NULL,
  "ci_status" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bc_account_repo_sha" ON "branch_commits" ("account_id","repo_id","sha");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bc_account_repo_time" ON "branch_commits" ("account_id","repo_id","committed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bc_account_idx" ON "branch_commits" ("account_id");
