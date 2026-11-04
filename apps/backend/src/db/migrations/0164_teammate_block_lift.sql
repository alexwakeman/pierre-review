-- LIFTING A TEAMMATE'S LIMN BLOCK (docs/CLAUDE-REVIEW.md § Lifting a teammate's block). On an imported
-- teammate review (`claude_reviews.kind = 'teammate'`), the reader's Limn's ONE attempt to dismiss that
-- teammate's standing Request changes: JSON `TeammateLiftRecord` — claimed (NULL → 'dismissing') by a
-- compare-and-set BEFORE the GitHub write, then settled 'dismissed' or 'failed' with GitHub's words.
-- Never retried: a row that is not NULL is never claimed again. The teammate-review import never writes
-- it. NULL on every run of the reader's own. Additive and nullable: no backfill.
ALTER TABLE `claude_reviews` ADD `teammate_lift` text;
