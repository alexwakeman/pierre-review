// THE `LIMN_AI_PROVIDER` SETTING, on its own so the pre-flight (`review/auth.ts` `detectClaudeAuth`)
// can read it without importing the provider registry (`ai/provider.ts` → `providers/claude.ts` →
// `review/auth.ts` would be a cycle). `ai/provider.ts` re-exports all of it.

import type { AgentKind } from './provider.js';

export const AI_PROVIDER_ENV = 'LIMN_AI_PROVIDER';

export type AiProviderSetting = 'claude' | 'codex' | 'auto';

export const CODEX_NOT_AVAILABLE_MESSAGE =
  'Codex is not available in this version of Limn yet. Unset LIMN_AI_PROVIDER (or set it to claude) to use Claude.';

/** The reader's `LIMN_AI_PROVIDER`, read at call time. Unset, empty or unknown ⇒ 'auto'. */
export function aiProviderSetting(env: NodeJS.ProcessEnv = process.env): AiProviderSetting {
  const raw = env[AI_PROVIDER_ENV]?.trim().toLowerCase();
  if (raw === 'claude' || raw === 'codex' || raw === 'auto') return raw;
  return 'auto';
}

// ---- which agents Codex may run (docs/CODEX-PLAN.md Phase 3) ------------------------------------

/**
 * THE ALLOW-LIST of agent kinds the Codex provider runs. EMPTY in Phase 2: only the one-shot
 * `complete()` runs on Codex; every agent kind answers `codexKindNotAvailableMessage(kind)`. Phase 3
 * adds each kind here in the same commit that ports its runner (result schema, progress, usage).
 */
export const CODEX_AGENT_KINDS: ReadonlySet<AgentKind> = new Set<AgentKind>([]);

/** Can Codex run this agent kind in this version? (`allow` is for tests.) */
export function codexKindReady(kind: AgentKind, allow: ReadonlySet<AgentKind> = CODEX_AGENT_KINDS): boolean {
  return allow.has(kind);
}

const KIND_WORDS: Record<AgentKind, string> = {
  review: 'pull request reviews',
  review_chat: 'the review chat',
  fix: 'AI Fix',
  plan: 'AI Fix plans',
  resolve: 'conflict resolution',
  ticket_review: 'ticket reviews',
  pr_card: 'ticket reviews',
  ci_review: 'CI reviews',
  thread_check: 'thread checks',
  diagram: 'design diagrams',
  sprint_paths: 'sprint critical paths',
  story_docs: 'checks against docs',
  docs_build: 'the docs library',
  docs_chat: 'the docs chat',
};

/** The one sentence a not-yet-ported agent kind answers on Codex. */
export function codexKindNotAvailableMessage(kind: AgentKind): string {
  return `Codex cannot run ${KIND_WORDS[kind] ?? 'this'} in this version of Limn yet. Unset LIMN_AI_PROVIDER (or set it to claude) to use Claude.`;
}
