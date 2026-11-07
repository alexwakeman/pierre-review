// THE CODEX KINDS OF PHASE 3 STREAM (b): AI Fix and Plan first (docs/CODEX-PLAN.md § 5). Its kinds: fix, plan.
// (`resolve`, the host-side "Resolve with Claude", was REMOVED 2026-11-07: conflicts are resolved by AI Fix's
// merge item in the sandbox, or by hand in the resolver.)
//
// ⚠ ADD A KIND HERE ONLY IN THE COMMIT THAT PORTS ITS RUNNER (result schema, progress, usage, tests
// on recorded Codex streams). `CODEX_AGENT_KINDS` (ai/provider-setting.ts) is the union of the four
// per-stream files, so the four streams never edit the same line. A kind NOT here answers "Codex cannot
// run … yet".
import type { AiAgentKind } from '@pierre-review/shared';

// `fix` and `plan` (AI Fix and Plan first) now run as a sandboxed workspace session through the Codex
// sandbox driver (sandbox/drivers/codex.ts; docs/SANDBOX.md), not through ai/providers/codex.ts; they stay
// listed because the picker and the pre-flight (`me.ai.kinds`, `codexRunnable()`) still ask by kind.
export const CODEX_FIX_KINDS: readonly AiAgentKind[] = ['fix', 'plan'];
