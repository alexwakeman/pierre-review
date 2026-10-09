-- REVIEW CHAT "EXPLAIN THESE" TURNS (docs/CLAUDE-REVIEW.md § Review chat). The Postgres twin is
-- migrations-pg/0082_review_chat_explain.sql. Additive; no data to move.
--
--   claude_review_chat_messages.pins          ClaudeReviewChatPin[] JSON on a USER row: the
--                                             findings / story items the reader sent to the chat,
--                                             as references plus the label the server built from
--                                             the stored rows at ask time. NULL = a plain question.
--   claude_review_chat_messages.explanations  ClaudeReviewChatExplanation[] JSON on an ASSISTANT
--                                             row: one card per pinned item, validated against the
--                                             pins before it is stored. NULL = a plain answer
--                                             (`content` is still the markdown the transcript reads).
ALTER TABLE `claude_review_chat_messages` ADD `pins` text;
--> statement-breakpoint
ALTER TABLE `claude_review_chat_messages` ADD `explanations` text;
