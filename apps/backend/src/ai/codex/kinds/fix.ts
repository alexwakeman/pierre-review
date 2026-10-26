// THE CODEX KINDS OF PHASE 3 STREAM (b): AI Fix, Plan first and Resolve with Claude (docs/CODEX-PLAN.md § 5).
// Its kinds: fix, plan, resolve.
//
// ⚠ ADD A KIND HERE ONLY IN THE COMMIT THAT PORTS ITS RUNNER (result schema, progress, usage, tests
// on recorded Codex streams). `CODEX_AGENT_KINDS` (ai/provider-setting.ts) is the union of the four
// per-stream files, so the four streams never edit the same line. A kind NOT here answers "Codex cannot
// run … yet".
import type { AiAgentKind } from '@pierre-review/shared';

// PORTED (Phase 3 stream b): AI Fix (coding/agent.ts runCodingAgent — the review and plain seeds, a
// WRITE run confined to the worktree, its writes read from git) and Resolve with Claude
// (coding/ai-resolve/run.ts, READ-ONLY). Each words its prompt for the provider (ai/prompt-tools.ts;
// Claude's text unchanged), answers through its strict result schema, and keeps every server-side
// check where it was (the fix's report validated at save, acceptAiChoices). Tests:
// coding/codex-fix.test.ts (offline) + coding/codex-fix.live.test.ts (opt-in).
// PLAN FIRST (coding/agent.ts runPlanAgent, READ-ONLY, the strict `submit_plan` schema) joined after
// its live runs passed (gpt-6-luna, low effort, 2026-10-25): a plan for the task, and a plan with one
// step for a task the code already did. Its first live failure was a fixture that already held the
// fix plus an invented ref; the Codex wording now says a ref-less task always needs a step
// (ai-fix/plan.ts CODEX_PLAN_REFS_RULE / CODEX_PLAIN_TASK_RULE). With it every agent kind is ported.
export const CODEX_FIX_KINDS: readonly AiAgentKind[] = ['fix', 'plan', 'resolve'];
