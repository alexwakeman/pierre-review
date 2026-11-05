-- MY TURN → "NEW AI REVIEWS BY YOUR LIMN" (docs/BACKEND.md § My Turn): when the reader first had a run
-- on screen in the PR's AI Review tab after it finished. NULL = not seen — the newest such run on an
-- open PR is a `claude_review` My Turn card until it is seen or dismissed.
ALTER TABLE `claude_reviews` ADD `seen_at` integer;
--> statement-breakpoint
-- Every run that already finished is treated as seen: the card's meaning changed (it used to be
-- "un-posted findings"), and an upgrade must not drop every PR's latest review onto My Turn at once.
UPDATE `claude_reviews` SET `seen_at` = coalesce(`finished_at`, `created_at`) WHERE `status` = 'succeeded';
--> statement-breakpoint
-- The red default branch is no longer a My Turn type: its repository-subject dismissals have no item
-- to hide. (The `repo_id` column stays, dormant.)
DELETE FROM `my_turn_dismissals` WHERE `pr_id` IS NULL;
