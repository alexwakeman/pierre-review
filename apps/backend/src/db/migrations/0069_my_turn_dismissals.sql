-- MY TURN DISMISSALS (CORE, free, both modes) — "take this off my plate for now".
--
-- ⚠ THE SAME TABLE NAME AS THE ONE 0060 DROPPED, AND NOT THE SAME CONTRACT. 0060's table backed a
-- "Done" button whose rows NEVER EXPIRED: press it on a review request and the request stayed
-- hidden while the work stayed real — on the author's account a PR whose ball was genuinely back
-- in their court sat invisible for weeks. Read 0060's header before touching this; everything it
-- objected to is answered here by what the row does NOT decide:
--
--   • it holds ONE timestamp. `getMyTurn` hides a dismissed subject's items only while each item's
--     own clock is at or before `dismissed_at`; anything that happens LATER shows again, alone;
--   • a subject with NO My Turn item at all (you acted, it closed, the request was withdrawn)
--     DISCHARGES its row, so a later summons starts fresh instead of arriving already dismissed.
--
-- So a dismissal never outlives the thing it dismissed. The ball rule still decides what is on the
-- plate; this only lets the reader set one item down until something new happens to it.
--
-- ONE ROW PER SUBJECT — a pull request (`pr_id`) or, for a red default branch, a repository
-- (`repo_id`); exactly one is set. Never per card: a PR can hold several My Turn jobs, and
-- dismissing the one on screen must not surface the next one behind it.
--
-- Both ids arrive in a request path, so tenancy is STRUCTURAL: composite FKs against
-- `(id, account_id)`. `repos_id_account` already exists (0042); `pull_requests_id_account` is new
-- here and exists only as that parent key (`id` is the primary key, so it is never a lookup). A
-- composite FK with a NULL member is not checked (MATCH SIMPLE), which is what lets one table carry
-- both subject kinds. The Postgres twin is migrations-pg/0056_my_turn_dismissals.sql.
CREATE UNIQUE INDEX IF NOT EXISTS `pull_requests_id_account` ON `pull_requests` (`id`,`account_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `my_turn_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer,
	`repo_id` integer,
	`dismissed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `my_turn_dismissals_pr_account_fk` FOREIGN KEY (`pr_id`,`account_id`) REFERENCES `pull_requests`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `my_turn_dismissals_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `my_turn_dismissals_account_pr` ON `my_turn_dismissals` (`account_id`,`pr_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `my_turn_dismissals_account_repo` ON `my_turn_dismissals` (`account_id`,`repo_id`);
