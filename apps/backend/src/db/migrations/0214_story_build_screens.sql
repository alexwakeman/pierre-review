-- SCREENS IN THE BUILD REPORT (2026-11-21; docs/SANDBOX.md § The browser, docs/IMPLEMENT-UI-PLAN.md § 8). CORE.
--
--   story_builds.screens_json  NEW. The build report's screens (a SELF-REPORT): name, address, what the agent
--                              compared it with, its verdict and note, and the sha256 of each screenshot copied out.
--   story_build_shots          NEW. The screenshots themselves, copied out of the sandbox only after the host checked
--                              each is a PNG under its caps. Bytes in the row; unique per (account, build, sha256);
--                              the composite FK onto story_builds (id, account_id) cascades.
ALTER TABLE `story_builds` ADD `screens_json` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `story_build_shots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`build_id` integer NOT NULL,
	`sha256` text NOT NULL,
	`png` blob NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `story_build_shots_build_account_fk` FOREIGN KEY (`build_id`,`account_id`) REFERENCES `story_builds`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `story_build_shots_build_sha` ON `story_build_shots` (`account_id`,`build_id`,`sha256`);
