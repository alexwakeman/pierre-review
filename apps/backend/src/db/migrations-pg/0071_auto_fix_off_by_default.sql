-- Postgres twin of migrations/0084_auto_fix_off_by_default.sql: auto AI Fix is OFF by default,
-- and every existing workspace is switched off once.
ALTER TABLE "workspaces" ALTER COLUMN "auto_fix_enabled" SET DEFAULT false;
--> statement-breakpoint
UPDATE "workspaces" SET "auto_fix_enabled" = false;
