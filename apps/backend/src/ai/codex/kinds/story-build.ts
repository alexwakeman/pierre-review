// THE CODEX KINDS OF "IMPLEMENT STORY" (docs/STORY-BUILD.md § Codex): the read-only assess + plan pass
// (`story_plan`) and the per-repository write build (`story_build`).
//
// ⚠ LISTED FROM THE CONTRACT COMMIT (C0), BEFORE THEIR RUNNERS EXIST — a deliberate exception to the
// "add a kind only in the commit that ports its runner" rule of the other four files. `codexRunnable()`
// requires EVERY agent kind in `CODEX_AGENT_KINDS`, so leaving these two out would switch Codex off for
// every feature the day the kinds land. Nothing calls `runAgent` with either kind until WP1 (story_plan)
// and WP2 (story_build) land, and each of those MUST ship its Codex port (strict result schema in
// ai/result-schemas.ts, workspace-MCP read roots, the write-deny rule in ai/codex/hook-rule.ts, offline
// tests on recorded streams) in the same commit as the runner.
import type { AiAgentKind } from '@pierre-review/shared';

export const CODEX_STORY_BUILD_KINDS: readonly AiAgentKind[] = ['story_plan', 'story_build'];
