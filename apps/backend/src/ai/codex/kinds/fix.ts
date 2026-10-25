// THE CODEX KINDS OF PHASE 3 STREAM (b): AI Fix, Plan first and Resolve with Claude (docs/CODEX-PLAN.md § 5).
// Its kinds: fix, plan, resolve.
//
// ⚠ ADD A KIND HERE ONLY IN THE COMMIT THAT PORTS ITS RUNNER (result schema, progress, usage, tests
// on recorded Codex streams). `CODEX_AGENT_KINDS` (ai/provider-setting.ts) is the union of the four
// per-stream files, so the four streams never edit the same line. EMPTY until then: every kind here
// answers "Codex cannot run … yet".
import type { AiAgentKind } from '@pierre-review/shared';

export const CODEX_FIX_KINDS: readonly AiAgentKind[] = [];
