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
//
// PORTED:
//   story_plan   coding/story-build/plan-agent.ts (WP1) — READ-ONLY: the scratch cwd (REPOS.md), every
//                candidate checkout and the library when usable as READ roots, no write root; result
//                `submit_story_plan` (strict schema, the nested design nullable), judged by the SAME
//                `judgeStoryPlan` (the one `exec resume` retry carries its refusal; Codex's second answer is
//                its last, so a design still wrong there is dropped and the plan kept); effort from
//                Settings → AI → Effort; the provider writes the ledger row. Tests: story-plan.test.ts.
//   story_build  WP2 (not yet).
import type { AiAgentKind } from '@pierre-review/shared';

export const CODEX_STORY_BUILD_KINDS: readonly AiAgentKind[] = ['story_plan', 'story_build'];
