-- THE PENDING MUTE (CORE, free, no AI). "Stop these Pending items claiming my turn."
--
-- WHAT A MUTE DOES, AND WHAT IT DELIBERATELY DOES NOT DO. A muted repo's "your turn"-shaped rows
-- are downgraded to `relevance: 'none'` (hence `personal: false`) inside `getMyTurn` — the ONE
-- place `personal` is folded from `relevance`. From that single write: the Pending card relabels
-- from "Your turn"/"In your repos" to the neutral "Review or reply", the browser notification
-- stops firing, the welcome-back banner / workspace badges / "N need your attention" line stop
-- counting it, and it moves into the broad "review or reply" population. The row itself, the
-- board's membership and the broad `myTurn` count are UNCHANGED. Muting routes work; it never
-- deletes it.
--
-- ⚠ THIS IS NOT THE `repos.inbox_watch` AXIS THAT MIGRATION 0046 DROPPED, and the next reader
-- will assume it is. `inbox_watch` was a SECOND VISIBILITY SCOPE sitting on top of "is this repo
-- added": it decided whether a repo's work appeared at all, which made "which of the two is this
-- screen obeying?" a live question on every surface, and collapsing to one scope (the Workspace)
-- is what 0044-0046 bought. NOTHING HERE CHANGES ANY SCREEN'S POPULATION. A muted repo is fully
-- live on Feed, Timeline, Activity, Bots and the Pending board; what changes is whether its rows
-- may CLAIM THE READER'S TURN and interrupt them. Membership is still the only visibility axis.
--
-- ⚠ TWO INDEPENDENT FACTS, OR-ed — NOT AN INHERITANCE CHAIN:
--
--       muted(repo)  ==  its workspace's `workspaces.pending_muted`  OR  a `pending_muted_repos` row
--
-- Workspace-grain alone does not answer the ask (one noisy repo in a useful workspace); repo-grain
-- alone makes silencing a 20-repo workspace twenty clicks. `null`-means-inherit is a named bug
-- class in this codebase (`workspace_reviewers.monthly_cents`, the Slack target, the sprint
-- cadence) — it needs a resolver and "which grain am I reading?" then has to be answered at every
-- call site. There is no resolver: there is one union, computed once in db/pending-mute.ts, and
-- clearing either half never reveals or overwrites the other.
--
-- ⚠ `pending_muted_repos` HAS NO `workspace_id`, DELIBERATELY. A repo belongs to EXACTLY ONE
-- workspace (`workspace_repos`, UNIQUE (account_id, repo_id)); copying that onto this row would
-- give the account two answers to "which workspace is this repo in". The consequence is intended:
-- a repo moved between workspaces carries its own mute with it.
--
-- ⚠ IT IS NOT THE ORPHANED `bot_mute_rules` TABLE (migration 0029) EITHER. That backed the removed
-- Pierre-only "hide" mute plus a standing auto-resolve cron — it HID review threads and RESOLVED
-- them on a timer. This mutes nothing and resolves nothing; it changes one advisory flag.
--
-- PRESENCE IS THE FACT on the repo half: no `muted` boolean and no "considered, not muted" row, so
-- every reader is one indexed existence check. The Postgres twin is
-- migrations-pg/0045_pending_mute.sql.
ALTER TABLE `workspaces` ADD `pending_muted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pending_muted_repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `pending_muted_repos_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pending_muted_repos_account_repo` ON `pending_muted_repos` (`account_id`,`repo_id`);
