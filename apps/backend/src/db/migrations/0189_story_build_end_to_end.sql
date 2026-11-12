-- IMPLEMENT STORY: "BUILD END TO END" (2026-11-12; docs/STORY-BUILD.md § Build end to end). CORE, additive.
--
--   story_builds.end_to_end              the reader's one-click start: plan approved automatically, the review
--                                        loop, then the Jira ticket. 0 = an ordinary build.
--   story_builds.e2e_ticket_claimed_at   the claim on the ONE ticket step (update + comment), taken before any
--                                        Jira write; NULL before. Never retried.
--   story_builds.e2e_ticket_json         what the ticket step did (shared StoryBuildEndToEndTicket); NULL before.
ALTER TABLE `story_builds` ADD COLUMN `end_to_end` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `e2e_ticket_claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `e2e_ticket_json` text;
