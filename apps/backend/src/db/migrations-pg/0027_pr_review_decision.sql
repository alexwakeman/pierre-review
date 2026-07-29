-- PR review decision — the Postgres twin of the sqlite migration 0040_pr_review_decision.
-- `merge_state_status = 'blocked'` never says WHY; GitHub's `PullRequest.reviewDecision` names
-- the review half ('review_required' / 'changes_requested' / 'approved'), which is what lets
-- the collapsed merge verdict be actionable. Additive + nullable; the next sync populates it.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "review_decision" text;
