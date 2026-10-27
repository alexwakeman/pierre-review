-- A FROM-SCRATCH Claude Review (`POST /api/prs/:id/claude-review` with `fresh: true`): the run read
-- no earlier review (no follow-up chain, no settled list, no carried thread judgements). 1 on such a
-- run; NULL on every other row, older ones included. Additive only.
ALTER TABLE `claude_reviews` ADD `fresh` integer;
