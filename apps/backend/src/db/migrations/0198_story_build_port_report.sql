-- IMPLEMENT STORY: THE HOTFIX PORT REPORT (2026-11-15; docs/STORY-BUILD.md § Hotfix builds → The port report,
-- docs/RELEASES.md § Port report). CORE, additive.
--
--   story_build_repos.port_report_json   the agent's word on the port to the default branch for this repository:
--                                        { outcome: same | adapted | not_needed, reason, evidence[] }, as the host
--                                        checked and clipped it. NULL = no report (never inferred). Untrusted text.
ALTER TABLE `story_build_repos` ADD COLUMN `port_report_json` text;
