-- AI FIX "RUN TESTS" (docs/CLAUDE-REVIEW.md § AI Fix "Run tests"; coding/checks/). JSON AiFixChecks:
-- the check names the reader ticked (written at insert, so an approved plan's build runs the same
-- ones), then Limn's own results, the install steps and the commit hook. NULL = no tests were asked
-- for (every older row, every auto fix).
ALTER TABLE `ai_fixes` ADD `checks` text;
