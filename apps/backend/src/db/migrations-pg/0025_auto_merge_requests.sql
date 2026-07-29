-- Auto-merge intents ("arm it and walk away") — the Postgres twin of the sqlite migration
-- 0038_auto_merge_requests. See that file for the full rationale: one row per (account, PR)
-- recording a standing intent to merge once the blockers clear; `expected_head_oid` is the
-- consent anchor (a new push disarms rather than merging unseen code); `expires_at` is the
-- backstop. FKs CASCADE so a repo/PR delete and an account erasure clean up automatically.
CREATE TABLE IF NOT EXISTS "auto_merge_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "pr_id" integer NOT NULL REFERENCES "pull_requests"("id") ON DELETE cascade,
  "merge_method" text NOT NULL,
  "update_strategy" text NOT NULL,
  "expected_head_oid" text NOT NULL,
  "state" text NOT NULL,
  "armed_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_checked_at" timestamp with time zone,
  "last_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "amr_account_pr" ON "auto_merge_requests" ("account_id","pr_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "amr_account_idx" ON "auto_merge_requests" ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "amr_state_idx" ON "auto_merge_requests" ("state");
