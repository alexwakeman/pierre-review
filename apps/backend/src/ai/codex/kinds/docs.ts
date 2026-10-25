// THE CODEX KINDS OF PHASE 3 STREAM (d): design diagrams, sprint critical paths, the docs build and the docs chat (docs/CODEX-PLAN.md § 5).
// Its kinds: diagram, sprint_paths, docs_build, docs_chat.
//
// ⚠ ADD A KIND HERE ONLY IN THE COMMIT THAT PORTS ITS RUNNER (result schema, progress, usage, tests
// on recorded Codex streams). `CODEX_AGENT_KINDS` (ai/provider-setting.ts) is the union of the four
// per-stream files, so the four streams never edit the same line. EMPTY until then: every kind here
// answers "Codex cannot run … yet".
import type { AiAgentKind } from '@pierre-review/shared';

//
// PORTED (each through the active provider's `runAgent`, its result the strict schema of the SAME tool
// shape, judged by the SAME handler; tests on recorded Codex streams in ./docs.test.ts):
//   diagram       review/diagrams/agent.ts      — `submit_design`, validateDesign
//   sprint_paths  review/sprint-paths/agent.ts  — `submit_paths`, validateSprintPaths (the digit gate)
//   docs_build    reference-docs/agent.ts       — `submit_document` (record_sections + finish_document
//                                                 as ONE answer); ⚠ a PDF is refused on Codex
//   docs_chat     reference-docs/agent.ts       — no result tool: the final message is the answer
export const CODEX_DOCS_KINDS: readonly AiAgentKind[] = ['diagram', 'sprint_paths', 'docs_build', 'docs_chat'];
