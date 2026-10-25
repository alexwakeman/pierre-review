// THE CODEX KINDS OF PHASE 3 STREAM (b): AI Fix, Plan first and Resolve with Claude (docs/CODEX-PLAN.md § 5).
// Its kinds: fix, plan, resolve.
//
// ⚠ ADD A KIND HERE ONLY IN THE COMMIT THAT PORTS ITS RUNNER (result schema, progress, usage, tests
// on recorded Codex streams). `CODEX_AGENT_KINDS` (ai/provider-setting.ts) is the union of the four
// per-stream files, so the four streams never edit the same line. EMPTY until then: every kind here
// answers "Codex cannot run … yet".
import type { AiAgentKind } from '@pierre-review/shared';

// PORTED (Phase 3 stream b): AI Fix (coding/agent.ts runCodingAgent — the review and plain seeds, a
// WRITE run confined to the worktree, its writes read from git) and Resolve with Claude
// (coding/ai-resolve/run.ts, READ-ONLY). Each words its prompt for the provider (ai/prompt-tools.ts;
// Claude's text unchanged), answers through its strict result schema, and keeps every server-side
// check where it was (the fix's report validated at save, acceptAiChoices). Tests:
// coding/codex-fix.test.ts (offline) + coding/codex-fix.live.test.ts (opt-in).
// ⚠ NOT YET 'plan': Plan first is ported in code and passes offline, but its ONE live run (gpt-6-luna,
// low effort, 2026-10-25) answered with no steps twice and was refused by its own check. Add it here
// after a live run passes.
export const CODEX_FIX_KINDS: readonly AiAgentKind[] = ['fix', 'resolve'];
