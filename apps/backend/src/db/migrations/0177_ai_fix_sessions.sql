-- AI FIX ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions). CORE, additive: an `ai_fixes` row
-- carries a sandbox session (the same machine as Implement's, migration 0176). Every column is nullable,
-- so a row of the removed shell-less fixer reads as before (session_phase NULL = history).
--
--   ai_fixes.session_phase   SandboxSessionPhase. `status` is DERIVED from it (shared `aiFixStatusForPhase`).
--   ai_fixes.sandbox_ref     the session's resource id (the `limn.session` label, `fx<id>-…`); NULL once torn down.
--   ai_fixes.agent_ref       the agent's own conversation id (Claude session / Codex thread), sandbox-internal.
--   ai_fixes.runtime         'docker' | 'microsandbox' — what ran the sandbox.
--   ai_fixes.session_json    the session's shown state: boot steps, conversation, repositories, left-out
--                            edits. No secret, no patch.
--   ai_fixes.last_active_at  the last turn or reader action (the idle teardown).
--   ai_fixes.unattended      1 for an auto fix or dependency automation's fix (it closes after its turn).
--   ai_fixes.workspace_id    the workspace whose Settings → Sandbox booted it; Resume reuses it. No FK.
ALTER TABLE `ai_fixes` ADD `session_phase` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `sandbox_ref` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `agent_ref` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `runtime` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `session_json` text;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `last_active_at` integer;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `unattended` integer;
--> statement-breakpoint
ALTER TABLE `ai_fixes` ADD `workspace_id` integer;
--> statement-breakpoint
CREATE INDEX `af_account_session_phase` ON `ai_fixes` (`account_id`,`session_phase`);
