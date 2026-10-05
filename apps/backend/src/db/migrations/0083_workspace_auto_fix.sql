-- AUTO AI FIX, PER WORKSPACE — `workspaces.auto_fix_enabled`. After a succeeded AUTO Claude review
-- of the reader's OWN pull request, Limn may prepare one review-seeded AI Fix (never pushed;
-- coding/ai-fix/auto-fix.ts `maybeStartAutoFix`). This is that step's switch, edited in Settings
-- beside auto review and written by `setWorkspaceAutoReview` (review/claude-review/auto-settings.ts).
-- ⚠ DEFAULT TRUE (1) and NOT NULL: auto fix ran unconditionally before this column existed, so
-- every existing workspace keeps today's behaviour until someone switches it off. It only matters
-- while auto review is on, because it only runs after an auto review. The Postgres twin is
-- migrations-pg/0070_workspace_auto_fix.sql.
ALTER TABLE `workspaces` ADD `auto_fix_enabled` integer DEFAULT 1 NOT NULL;
