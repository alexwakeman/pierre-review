-- WORKSPACE SESSIONS (docs/SANDBOX.md § Sessions; plan WP7). CORE, additive: the "Implement story" rows
-- (migration 0149) carry a sandbox session. Every column is nullable or defaulted, so an old plan/build
-- row reads as before (session_phase NULL).
--
--   story_builds.session_phase    SandboxSessionPhase (booting · ready · chatting · building · built ·
--                                 pushed · discarded · failed). `status` is DERIVED from it
--                                 (shared `sandboxSessionStatus`), so the one-open-session index holds.
--   story_builds.runtime          'docker' | 'microsandbox' — what ran the sandbox.
--   story_builds.sandbox_ref      the session's resource id (the `limn.session` label); NULL once torn down.
--   story_builds.agent_ref        the agent's own conversation id (Claude session / Codex thread), sandbox-internal.
--   story_builds.session_json     the session's shown state: boot steps, notes, conversation, layout.
--                                 No secret, no patch.
--   story_builds.build_cost_usd   US$ of the build-mode turns (chat turns go to plan_cost_usd).
--   story_builds.last_active_at   the last turn or reader action (the idle teardown reads it).
--   story_build_repos.patch_sha   sha256 of the stored patch (the diff view's cache key).
--   story_build_repos.stat_json   {files, insertions, deletions, commits} of the stored patch.
--   story_build_repos.sandbox_path the repository's absolute path inside the sandbox.
ALTER TABLE `story_builds` ADD `session_phase` text;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD `runtime` text;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD `sandbox_ref` text;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD `agent_ref` text;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD `session_json` text;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD `build_cost_usd` real;
--> statement-breakpoint
ALTER TABLE `story_builds` ADD `last_active_at` integer;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD `patch_sha` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD `stat_json` text;
--> statement-breakpoint
ALTER TABLE `story_build_repos` ADD `sandbox_path` text;
