-- REPLIES TO LIMN'S OWN FINDINGS — the Postgres twin of migrations/0092_finding_pushback.sql (read
-- that file for the rationale). Additive.
ALTER TABLE "claude_review_findings" ADD COLUMN IF NOT EXISTS "pushback" jsonb;
