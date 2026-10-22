-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the sqlite 0012.
-- Run once by runPluginMigrations (tracked in pro_migrations). Idempotent.

CREATE TABLE IF NOT EXISTS "addressed_checks" (
  "id" serial PRIMARY KEY NOT NULL,
  "account_id" integer NOT NULL,
  "repo_id" integer NOT NULL,
  "pr_id" integer NOT NULL,
  "target_kind" text NOT NULL,
  "target_id" integer NOT NULL,
  "verdict" text NOT NULL,
  "confidence" integer NOT NULL,
  "rationale" text NOT NULL,
  "payload_hash" text NOT NULL,
  "model" text NOT NULL,
  "cost_usd" double precision,
  "input_tokens" integer,
  "output_tokens" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ac_account_target" ON "addressed_checks" ("account_id","target_kind","target_id");
