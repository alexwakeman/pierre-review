// THE CODEX KINDS OF PHASE 3 STREAM (b): AI Fix, Plan first and Resolve with Claude (docs/CODEX-PLAN.md § 5).
// Its kinds: fix, plan, resolve.
//
// ⚠ ADD A KIND HERE ONLY IN THE COMMIT THAT PORTS ITS RUNNER (result schema, progress, usage, tests
// on recorded Codex streams). `CODEX_AGENT_KINDS` (ai/provider-setting.ts) is the union of the four
// per-stream files, so the four streams never edit the same line. A kind NOT here answers "Codex cannot
// run … yet".
import type { AiAgentKind } from '@pierre-review/shared';

// `fix` and `plan` (AI Fix and Plan first) now run as a sandboxed workspace session through the Codex
// sandbox driver (sandbox/drivers/codex.ts; docs/SANDBOX.md), not through ai/providers/codex.ts; they stay
// listed because the picker and the pre-flight (`me.ai.kinds`, `codexRunnable()`) still ask by kind.
// `resolve` (Resolve with Claude, coding/ai-resolve/run.ts, READ-ONLY) runs through ai/providers/codex.ts
// with its strict result schema; offline test: coding/codex-resolve.test.ts.
export const CODEX_FIX_KINDS: readonly AiAgentKind[] = ['fix', 'plan', 'resolve'];
