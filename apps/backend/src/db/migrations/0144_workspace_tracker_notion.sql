-- NOTION AS AN ISSUE TRACKER (docs/TRACKERS.md § Notion). The workspace's Notion property mapping
-- (shared `NotionTrackerMapping`, JSON) beside the one tracker row it belongs to. Additive; NULL = none.
ALTER TABLE `workspace_trackers` ADD `notion_config` text;
