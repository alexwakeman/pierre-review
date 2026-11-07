// THE CODEX KINDS OF PHASE 3 STREAM (c): the ticket review, its pre-pass (contribution cards), the CI review and Check against docs (docs/CODEX-PLAN.md § 5).
// Its kinds: ticket_review, pr_card, ci_review, story_docs.
//
// ⚠ ADD A KIND HERE ONLY IN THE COMMIT THAT PORTS ITS RUNNER (result schema, progress, usage, tests
// on recorded Codex streams). `CODEX_AGENT_KINDS` (ai/provider-setting.ts) is the union of the four
// per-stream files, so the four streams never edit the same line.
//
// PORTED (each through the provider's `runAgent`, the run's provider resolved ONCE by its manager —
// review/run-provider.ts — so its prompt words and its runner agree; Claude's prompts byte-identical,
// pinned by tickets.test.ts against __fixtures__/tickets-claude-prompts.json):
//   ticket_review   review/ticket-review/agent.ts — read roots: the scratch cwd (MEMBERS.md), every
//                   member worktree and default-branch checkout, the library READ-ONLY when in use;
//                   result `submit_ticket_review` (strict schema), every server check unchanged
//                   (reconcile, validateRunCards, the doc-reference check).
//   pr_card         review/ticket-review/prepass.ts — diff-only: an EMPTY scratch cwd as its one root;
//                   result `submit_pr_card`, `normaliseCard` unchanged; the card stores the model that
//                   wrote it.
//   ci_review       review/ci-review/agent.ts — the scratch cwd + the PR's read-only worktree; result
//                   `submit_ci_review`, reconcile unchanged (refs the server handed out only).
//   story_docs      review/story-docs/agent.ts — the scratch cwd + the shortlisted documents' folders
//                   READ-ONLY (`storyDocsRoots`); result `submit_alignment`, judged by the SAME shape
//                   judge (the one Codex retry carries its refusal), every quote checked at storage.
// The ledger: a Codex run writes its own row (provider 'codex', its model, its tokens; US$ 0 on the
// ChatGPT sign-in) from `usageRecord`, and the managers' recorders skip it (`ledgerByProvider`).
// The spend-budget gate (review/budget-gate.ts) is asked by the ticket and CI sweeps exactly as before.
import type { AiAgentKind } from '@pierre-review/shared';

export const CODEX_TICKETS_KINDS: readonly AiAgentKind[] = ['ticket_review', 'pr_card', 'ci_review', 'story_docs'];
