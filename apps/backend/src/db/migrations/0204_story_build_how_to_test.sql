-- IMPLEMENT STORY: HOW TO TEST AFTER A BUILD (2026-11-16; docs/STORY-BUILD.md § How to test after a build).
-- CORE, additive. When a build turn stores work, Ensemble asks the story chat its "How to test" question
-- (an automatic run, behind the spend gate). `how_to_test_key` is the CLAIM: the hash of the stored work it
-- was asked for (compare-and-set, so one question per version of the work); `how_to_test_chat_id` the story
-- chat that holds the answer (NO FK: story_chats rows are re-scoped by account); `how_to_test_seen_at` when
-- the reader opened or dismissed it from the build tab (NULL = the tab points at it).
ALTER TABLE `story_builds` ADD COLUMN `how_to_test_key` text;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `how_to_test_chat_id` integer;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `how_to_test_seen_at` integer;
