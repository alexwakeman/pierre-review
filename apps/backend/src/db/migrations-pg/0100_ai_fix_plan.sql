-- AI FIX → PLAN MODE (2026-10-16). Twin of migrations/0113_ai_fix_plan.sql, where the contract
-- lives. Text JSON like the table's other JSON columns. All nullable, no backfill.
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "plan" text;
--> statement-breakpoint
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "plan_transcript" text;
--> statement-breakpoint
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "plan_status" text;
--> statement-breakpoint
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "plan_revision" integer;
--> statement-breakpoint
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "plan_seed" text;
--> statement-breakpoint
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "plan_cost_usd" double precision;
