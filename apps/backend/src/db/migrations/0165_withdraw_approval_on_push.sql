-- WITHDRAWING LIMN'S OWN APPROVAL ON A PUSH (docs/CLAUDE-REVIEW.md § Withdrawing Limn's approval).
-- ONE column, `workspaces.withdraw_approval_on_push`: when a PR's head moves off the commit Limn's OWN
-- automatic approval was given on, Limn dismisses that approval. NULL = ON (the default); only a
-- stored 0 is off. The claim and the outcome ride the approving run's `claude_reviews.auto_post` JSON
-- (`approvalWithdrawal`), so no other DDL. Additive and nullable: no backfill.
ALTER TABLE `workspaces` ADD `withdraw_approval_on_push` integer;
