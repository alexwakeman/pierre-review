-- IMPLEMENT STORY: "APPROVE THE PLAN AUTOMATICALLY" (2026-11-12; docs/STORY-BUILD.md § Approve
-- automatically). CORE, additive.
--
--   story_builds.auto_approve_plan       the reader's opt-in (Start panel, or the tab until the plan is approved).
--                                        0 = off (the default): the plan waits for "Approve and start".
--   story_builds.plan_auto_approved_at   set when Limn approved the plan itself (every open point taken as
--                                        Agree); NULL when the reader approved it, or before approval.
--   story_builds.ticket_review_done_at   the reader updated the ticket from the build tab, or said it needs no
--                                        update: the "ticket changes" step stops asking for attention. NULL before.
ALTER TABLE `story_builds` ADD COLUMN `auto_approve_plan` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `plan_auto_approved_at` integer;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD COLUMN `ticket_review_done_at` integer;
