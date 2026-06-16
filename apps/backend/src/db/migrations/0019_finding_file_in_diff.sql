-- Whether a Claude-review finding's file is part of the PR's diff (additive). true ⇒
-- an unanchored finding posts inline on the file's first change; false ⇒ the file is
-- outside the PR's diff (e.g. a deep review on an unchanged file) so it posts as a
-- standalone PR-level comment instead of being forced onto a diff line. NOT NULL
-- DEFAULT 1 so pre-existing findings keep the inline-on-first-change behavior.
-- SQLite-only — Claude Review is force-disabled in cloud.
ALTER TABLE `claude_review_findings` ADD `file_in_diff` integer NOT NULL DEFAULT 1;
