-- THE AUTO VERDICT'S TWO RULES + THE NOT-APPROVED REASON (docs/CLAUDE-REVIEW.md § Auto-posting →
-- AUTO VERDICT). Both workspace columns are OVERRIDES ONLY: NULL = today's rule.
-- `pair_verdict_strictness`: how a Claude + Codex pair's verdict is folded — NULL / 'strict' = approve
-- only when both approved; 'relaxed' = approve when one approved and neither asked for changes.
ALTER TABLE `workspaces` ADD `pair_verdict_strictness` text;
--> statement-breakpoint
-- `approve_leftovers`: which open findings may remain when Limn approves — NULL / 'nits_questions' =
-- nits and questions; 'nits' = nits only; 'none' = nothing open at all.
ALTER TABLE `workspaces` ADD `approve_leftovers` text;
--> statement-breakpoint
-- A REPLIES PASS's not-approved reason ({heldReason, text}), written when the pass ends while the
-- workspace's auto verdict is on. NULL on every other row (a full review's reason is on its
-- `auto_post` record, or computed on read).
ALTER TABLE `claude_reviews` ADD `verdict_reason` text;
