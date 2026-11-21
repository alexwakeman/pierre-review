-- THE BUILD'S SCREENSHOTS ON THE TICKET (2026-11-21; docs/TRACKERS.md § The build's screenshots). CORE.
--
--   story_builds.screens_ticket_json  NEW. The reader's ONE press "Post screenshots to the ticket": CLAIMED
--                                     (compare-and-set from NULL) before the first Jira write; then posted, or the
--                                     error. A failure before anything was written releases the claim; after, never
--                                     retried.
ALTER TABLE `story_builds` ADD `screens_ticket_json` text;
