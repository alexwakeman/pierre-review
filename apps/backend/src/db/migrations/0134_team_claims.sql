-- TEAM CLAIMS (docs/CLAUDE-REVIEW.md § Team claims). Two additive columns:
--   workspaces.team_claims_enabled  "Mark auto reviews on GitHub": an auto review posts a commit
--                                   status (limn/review-claude | limn/review-codex) on the PR's head
--                                   so teammates' Limn skips a commit someone is already reviewing.
--                                   NULL/0 = OFF, the default for every workspace.
--   claude_reviews.team_claim       what the claim did for THIS run (JSON, ClaudeTeamClaimRecord).
--                                   NULL = no claim was attempted (a manual run, or the switch off).
ALTER TABLE `workspaces` ADD `team_claims_enabled` integer;
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `team_claim` text;
