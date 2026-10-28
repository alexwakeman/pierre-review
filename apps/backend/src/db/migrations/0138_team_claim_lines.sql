-- THE TEAM-CLAIM LEDGER (docs/CLAUDE-REVIEW.md § Team claims → Releasing stale lines). One row per
-- GitHub status line (`limn/review-claude` | `limn/review-codex`) Limn holds or released on a PR
-- head, written BEFORE the pending line is posted, so a restart, a dropped run or a failed final write
-- never leaves this machine's line pending: the reconciler releases every open row whose run is not
-- running. `whose = 'teammate'` records a teammate's expired line released once.
CREATE TABLE `team_claim_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`repo_id` integer,
	`owner` text,
	`name` text,
	`head_sha` text NOT NULL,
	`provider` text NOT NULL,
	`review_id` integer,
	`whose` text DEFAULT 'mine' NOT NULL,
	`state` text NOT NULL,
	`login` text,
	`final_description` text,
	`final_target_url` text,
	`release_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `team_claim_lines_state` ON `team_claim_lines` (`state`);
--> statement-breakpoint
CREATE INDEX `team_claim_lines_account_pr_head` ON `team_claim_lines` (`account_id`,`pr_id`,`head_sha`);
--> statement-breakpoint
-- Lines older Limn versions left PENDING (a failed run's "didn't finish · free to claim", or a run that
-- died mid-way): the newest auto run's record per (PR, head, context), when it is still pending, from
-- the last 14 days. The reconciler replaces each with the success release line at boot — only where the
-- head's newest line is still this account's pending one (it reads GitHub first).
INSERT INTO `team_claim_lines` (`account_id`, `pr_id`, `repo_id`, `owner`, `name`, `head_sha`, `provider`, `review_id`, `whose`, `state`)
SELECT cr.`account_id`, cr.`pr_id`, pr.`repo_id`, r.`owner`, r.`name`, cr.`head_sha`,
	CASE json_extract(cr.`team_claim`, '$.context') WHEN 'limn/review-codex' THEN 'codex' ELSE 'claude' END,
	cr.`id`, 'mine', 'pending'
FROM `claude_reviews` cr
JOIN `pull_requests` pr ON pr.`id` = cr.`pr_id`
JOIN `repos` r ON r.`id` = pr.`repo_id`
WHERE cr.`team_claim` IS NOT NULL
	AND json_valid(cr.`team_claim`)
	AND json_extract(cr.`team_claim`, '$.state') = 'marked'
	AND json_extract(cr.`team_claim`, '$.lastLine') IN ('reviewing', 'unfinished')
	AND cr.`created_at` >= unixepoch() - 14 * 86400
	AND cr.`id` = (
		SELECT MAX(c2.`id`) FROM `claude_reviews` c2
		WHERE c2.`account_id` = cr.`account_id`
			AND c2.`pr_id` = cr.`pr_id`
			AND c2.`head_sha` = cr.`head_sha`
			AND c2.`team_claim` IS NOT NULL
			AND json_valid(c2.`team_claim`)
			AND json_extract(c2.`team_claim`, '$.context') = json_extract(cr.`team_claim`, '$.context')
	);
