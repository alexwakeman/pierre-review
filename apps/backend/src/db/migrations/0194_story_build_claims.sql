-- THE STORY-BUILD CLAIM LEDGER (2026-11-15; docs/TEAM-REVIEW.md § Implement and Fill gaps, docs/STORY-BUILD.md
-- § The team claim). CORE, additive.
--
--   story_build_claim_lines  NEW: one row per commit status a story build of this machine holds or released —
--       the `ensemble/build` claim on the ticket branch's head (kind 'build') and the review loop's
--       `ensemble/review-<provider>` lines on the branch it reviews (kind 'review') — written BEFORE the line
--       is posted and moved on after every write, so a crash, a restart or a final write GitHub did not take
--       leaves a row the reconciler (coding/story-build/build-claim-release.ts) can still release. No FK on
--       build_id (deps_claim_lines' precedent): a deleted build's line must still be released; the erasure
--       deletes everything.
CREATE TABLE IF NOT EXISTS `story_build_claim_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`build_id` integer,
	`workspace_id` integer,
	`ident` text,
	`kind` text NOT NULL,
	`context` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`branch` text,
	`head_sha` text NOT NULL,
	`provider` text,
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
CREATE INDEX IF NOT EXISTS `story_build_claim_lines_state` ON `story_build_claim_lines` (`state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_build_claim_lines_account_build` ON `story_build_claim_lines` (`account_id`,`build_id`);
