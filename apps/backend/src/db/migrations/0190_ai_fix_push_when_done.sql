-- AI FIX: "PUSH WHEN DONE" (2026-11-12; docs/CLAUDE-REVIEW.md § AI Fix). CORE, additive.
--
--   ai_fixes.push_when_done   the reader's tick at start: a MANUAL fix that finished cleanly on the reader's own
--                             PR is pushed without a press. 0 = wait for Push (every existing row).
ALTER TABLE `ai_fixes` ADD COLUMN `push_when_done` integer NOT NULL DEFAULT 0;
