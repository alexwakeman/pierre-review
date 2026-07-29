-- PR review decision, SQLite / local mode.
--
-- `merge_state_status = 'blocked'` says branch protection is unmet but never WHY, so every
-- merge surface could only render a shrug. GitHub's `PullRequest.reviewDecision` names the
-- review half of it ('review_required' / 'changes_requested' / 'approved'), which is what lets
-- the collapsed merge verdict say something actionable.
--
-- Additive + nullable, so the backfill is a no-op: the next sync populates it. Stored lowercased
-- to match this schema's enum convention. Postgres twin: migrations-pg/0027_pr_review_decision.sql.
ALTER TABLE `pull_requests` ADD `review_decision` text;
