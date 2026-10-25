// THE CODEX KINDS OF PHASE 3 STREAM (d): design diagrams, sprint critical paths, the docs build and the docs chat (docs/CODEX-PLAN.md § 5).
// Its kinds: diagram, sprint_paths, docs_build, docs_chat.
//
// ⚠ ADD A KIND HERE ONLY IN THE COMMIT THAT PORTS ITS RUNNER (result schema, progress, usage, tests
// on recorded Codex streams). `CODEX_AGENT_KINDS` (ai/provider-setting.ts) is the union of the four
// per-stream files, so the four streams never edit the same line. EMPTY until then: every kind here
// answers "Codex cannot run … yet".
import type { AiAgentKind } from '@pierre-review/shared';

export const CODEX_DOCS_KINDS: readonly AiAgentKind[] = [];
