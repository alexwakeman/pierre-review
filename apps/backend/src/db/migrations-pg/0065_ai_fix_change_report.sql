-- Postgres twin of migrations/0078_ai_fix_change_report.sql, where the contract lives:
-- ai_fixes.trigger ('manual' | 'auto'), ai_fixes.review_items (the review items a 'review' run was
-- given, with refs) and ai_fixes.change_report (the validated per-change report). Text JSON like
-- the table's other JSON columns. All nullable, no backfill.
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "trigger" text;
--> statement-breakpoint
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "review_items" text;
--> statement-breakpoint
ALTER TABLE "ai_fixes" ADD COLUMN IF NOT EXISTS "change_report" text;
