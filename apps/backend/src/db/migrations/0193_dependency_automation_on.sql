-- DEPENDENCY AUTOMATION ON BY DEFAULT + THE DEPENDENCY CLAIM LEDGER (2026-11-14; docs/MERGE-CI-TRUNK.md §
-- Dependency automation, docs/TEAM-REVIEW.md § Dependency updates). CORE, additive.
--
--   workspaces.dependency_auto_merge / _approve / _resolve / _fix
--       The product owner's decision: every switch is ON by default. A NULL used to read OFF; from now
--       on NULL reads ON and OFF is stored as an explicit 0 (`setDependencyAutomation`,
--       `setDependencyAutoMerge`). Existing NULLs become 1 here — INCLUDING workspaces whose NULL meant
--       "switched off" (the writers stored NULL for off), which the owner accepted. A stored 0 (none
--       was ever written before this file) is kept.
--   workspace_reviewers.dependency_trusted
--       Unchanged on disk. NULL now RESOLVES to trusted for dependabot[bot] and renovate[bot] (GitHub App
--       logins: the `[bot]` suffix is reserved) and to untrusted for every other bot; an untick is now
--       stored as 0, so it wins. Nothing is backfilled.
--   deps_claim_lines  NEW: the `limn/deps` line ledger (merge/deps-claim-ledger.ts), one row per line this
--       machine holds or released, so a line is never left pending by a crash, a failed final write is
--       retried, an armed merge's line is renewed and released, an AI-pushed commit's line is retried,
--       and a teammate's expired line is released ONCE. No FK on pr_id (team_claim_lines' precedent):
--       both delete paths keep this machine's OPEN rows; the erasure deletes everything.
UPDATE `workspaces` SET `dependency_auto_merge` = 1 WHERE `dependency_auto_merge` IS NULL;
--> statement-breakpoint
UPDATE `workspaces` SET `dependency_auto_approve` = 1 WHERE `dependency_auto_approve` IS NULL;
--> statement-breakpoint
UPDATE `workspaces` SET `dependency_auto_resolve` = 1 WHERE `dependency_auto_resolve` IS NULL;
--> statement-breakpoint
UPDATE `workspaces` SET `dependency_auto_fix` = 1 WHERE `dependency_auto_fix` IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deps_claim_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`repo_id` integer,
	`owner` text,
	`name` text,
	`head_sha` text NOT NULL,
	`action` text NOT NULL,
	`whose` text DEFAULT 'mine' NOT NULL,
	`state` text NOT NULL,
	`login` text,
	`last_description` text,
	`final_description` text,
	`last_posted_at` integer,
	`release_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `deps_claim_lines_state` ON `deps_claim_lines` (`state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `deps_claim_lines_account_pr_head` ON `deps_claim_lines` (`account_id`,`pr_id`,`head_sha`);
