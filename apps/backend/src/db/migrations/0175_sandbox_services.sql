-- SANDBOX SERVICES (docs/SANDBOX.md § Services). CORE, additive.
--
--   sandbox_workspace_settings.services_json  NEW, nullable: the compose files the reader picked for a
--                                             workspace's sessions, as JSON
--                                             `[{repo: "owner/name", file: "compose.yml", egress: [service…]}]`.
--                                             NULL = none (Limn never runs a file the reader did not pick).
ALTER TABLE `sandbox_workspace_settings` ADD `services_json` text;
