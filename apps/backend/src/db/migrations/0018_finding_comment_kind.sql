-- Records how a posted Claude-review finding was attached to the PR (additive):
-- 'inline' = a review comment on a diff line, 'pr_comment' = a standalone PR-level
-- issue comment (used when the user posts an UNANCHORED finding individually rather
-- than forcing it onto a diff line). Null until posted; the UI uses it to build the
-- correct GitHub permalink (#discussion_r vs #issuecomment). SQLite-only — Claude
-- Review is force-disabled in cloud, so the Postgres table is never populated.
ALTER TABLE `claude_review_findings` ADD `posted_comment_kind` text;
