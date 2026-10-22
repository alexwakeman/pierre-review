-- @pierre/pro plugin migration (Postgres / cloud mode). Twin of migrations/0036_workspace_auto_review.sql,
-- where the contract lives. No journal, no statement-breakpoint.
--
-- Claude Review (and so auto review) is LOCAL-ONLY - the sweeper never starts in cloud - but the
-- columns exist here too so the two schemas stay the same shape.
--
-- ⚠ A PLUGIN pg MIGRATION THAT FAILS IS DOWNGRADED TO A WARNING and silently drops the whole
-- plugin to OSS mode, so every statement is replay-safe (`IF NOT EXISTS`). Mirrored BY EYE: this
-- package has no schema-parity test.

ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS auto_review_enabled boolean;
ALTER TABLE pro_workspace_settings ADD COLUMN IF NOT EXISTS auto_review_enabled_at timestamptz;
