-- CLAUDE + CODEX: ONE REVIEW BY BOTH (docs/CLAUDE-REVIEW.md § Claude + Codex). When a pair ends its two
-- halves are consolidated into one review. `pair_consolidation` (on the pair's FIRST row only) holds
-- the one summary, the code-computed verdict, each kept finding's source, the merged-away duplicates
-- and the half that did not finish; NULL everywhere else. `merged_into` marks a finding the other
-- half's finding stands for (never shown, posted, counted or sent to AI Fix); NULL everywhere else.
ALTER TABLE `claude_reviews` ADD `pair_consolidation` text;
--> statement-breakpoint
ALTER TABLE `claude_review_findings` ADD `merged_into` integer;
