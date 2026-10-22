-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the sqlite 0017.
-- Run once by runPluginMigrations (tracked in pro_migrations). Idempotent.
--
-- The comment-ANNOTATIONS platform: one table for any AI judgement ABOUT a review comment,
-- discriminated by (kind, target_kind) instead of a new table per judgement type.

CREATE TABLE IF NOT EXISTS "pr_comment_annotations" (
  "id" serial PRIMARY KEY NOT NULL,
  "account_id" integer NOT NULL,
  "repo_id" integer NOT NULL,
  "pr_id" integer NOT NULL,
  "kind" text NOT NULL,
  "target_kind" text NOT NULL,
  "target_id" integer NOT NULL,
  "verdict" text,
  "confidence" integer,
  "body" text NOT NULL,
  "payload_hash" text NOT NULL,
  "model" text NOT NULL,
  "cost_usd" double precision,
  "input_tokens" integer,
  "output_tokens" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "pca_account_kind_target"
  ON "pr_comment_annotations" ("account_id","kind","target_kind","target_id");

CREATE INDEX IF NOT EXISTS "pca_account_pr_kind"
  ON "pr_comment_annotations" ("account_id","pr_id","kind");

-- Backfill the existing comment-validity assessments (0011) as kind='validity' on the comment
-- they were about. `assessment` becomes `body`; the old shape has no confidence, so NULL.
-- ON CONFLICT DO NOTHING (the unique index is the guard) so a re-apply is safe.
-- comment_assessments is deliberately NOT dropped — it stays readable while the new writer
-- takes over, so a rollback is a code change rather than a data restore.
INSERT INTO "pr_comment_annotations" (
  "account_id", "repo_id", "pr_id", "kind", "target_kind", "target_id",
  "verdict", "confidence", "body", "payload_hash", "model",
  "cost_usd", "input_tokens", "output_tokens", "created_at"
)
SELECT
  ca."account_id",
  ca."repo_id",
  ca."pr_id",
  'validity',
  'review_comment',
  ca."comment_id",
  ca."verdict",
  NULL,
  ca."assessment",
  ca."payload_hash",
  ca."model",
  ca."cost_usd",
  ca."input_tokens",
  ca."output_tokens",
  ca."created_at"
FROM "comment_assessments" ca
ON CONFLICT DO NOTHING;
