-- Postgres twin of migrations/0072_commit_message_headline.sql, where the contract lives.
-- Nullable: NULL is "not synced yet", never an empty headline.
ALTER TABLE "commits" ADD COLUMN IF NOT EXISTS "message_headline" text;
