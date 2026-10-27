-- A REPLIES PASS (docs/CLAUDE-REVIEW.md § The replies pass): a light run that judges only people's
-- replies on Limn's own posted findings, stored as a `claude_reviews` row so history shows it and
-- its follow-up items read like any review's. 'replies' on such a row; NULL on every full review,
-- older ones included. Additive only.
ALTER TABLE `claude_reviews` ADD `kind` text;
