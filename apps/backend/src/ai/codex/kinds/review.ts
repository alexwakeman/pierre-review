// THE CODEX KINDS OF PHASE 3 STREAM (a): Claude Review, its specialists (§ 3.5), the review chat and Check threads (docs/CODEX-PLAN.md § 5).
// Its kinds: review, review_chat, thread_check.
//
// ⚠ ADD A KIND HERE ONLY IN THE COMMIT THAT PORTS ITS RUNNER (result schema, progress, usage, tests
// on recorded Codex streams). `CODEX_AGENT_KINDS` (ai/provider-setting.ts) is the union of the four
// per-stream files, so the four streams never edit the same line. EMPTY until then: every kind here
// answers "Codex cannot run … yet".
//
// PORTED (stream a): review (review/agent.ts — both depths, the diff-only and worktree efforts, Limn-run
// specialists), review_chat (review/chat-agent.ts — plain answers and explain turns) and thread_check
// (review/claude-review/thread-check-agent.ts). Codex words: review/codex-wording.ts; Codex-only run
// pieces: review/codex-review.ts; tests: review/codex-review-runs.test.ts (+ the opt-in live test).
import type { AiAgentKind } from '@pierre-review/shared';

export const CODEX_REVIEW_KINDS: readonly AiAgentKind[] = ['review', 'review_chat', 'thread_check'];
