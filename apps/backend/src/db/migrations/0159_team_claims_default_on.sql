-- TEAM CLAIMS ON BY DEFAULT (docs/CLAUDE-REVIEW.md § Team claims, 2026-11-02). The owner: "Just on
-- by default on all workspaces". Every existing workspace is switched ON (also one switched off
-- before); a new workspace's NULL now reads as ON (only a stored false is off).
UPDATE `workspaces` SET `team_claims_enabled` = 1;
--> statement-breakpoint
-- A TEAMMATE'S LINE THIS LIMN STOOD DOWN FOR: one row per (account, PR, head, provider), shown on the
-- AI Review tab ("Robin Dunn reviewed this commit with Claude · no comments").
CREATE TABLE `team_claim_seen` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`login` text NOT NULL,
	`description` text,
	`line_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_claim_seen_account_pr_head_provider` ON `team_claim_seen` (`account_id`,`pr_id`,`head_sha`,`provider`);
