// THE `LIMN_AI_PROVIDER` SETTING, on its own so the pre-flight (`review/auth.ts` `detectClaudeAuth`)
// can read it without importing the provider registry (`ai/provider.ts` → `providers/claude.ts` →
// `review/auth.ts` would be a cycle). `ai/provider.ts` re-exports all of it. Also here, for the same
// reason: WHICH provider is active (`activeProviderId`, the `auto` rule) and which agent kinds Codex
// may run (`CODEX_AGENT_KINDS`, the union of the four Phase 3 streams' own files).

import type { AiRunKind } from '@pierre-review/shared';
import { codexCredentialRunnable, resolveAiCredential, resolveCodexCredential } from './credentials.js';
import { CODEX_DOCS_KINDS } from './codex/kinds/docs.js';
import { CODEX_FIX_KINDS } from './codex/kinds/fix.js';
import { CODEX_REVIEW_KINDS } from './codex/kinds/review.js';
import { CODEX_TICKETS_KINDS } from './codex/kinds/tickets.js';
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
 * THE ALLOW-LIST of agent kinds the Codex provider runs: the UNION of the four Phase 3 streams' files
 * (`ai/codex/kinds/{review,fix,tickets,docs}.ts`), so no two streams edit the same line. EMPTY until a
 * stream ports its runner: only the one-shot `complete()` runs on Codex, and every agent kind answers
 * `codexKindNotAvailableMessage(kind)`. A stream adds each kind to ITS file in the same commit that
 * ports the runner (result schema, progress, usage).
 */
export const CODEX_AGENT_KINDS: ReadonlySet<AgentKind> = new Set<AgentKind>([
  ...CODEX_REVIEW_KINDS,
  ...CODEX_FIX_KINDS,
  ...CODEX_TICKETS_KINDS,
  ...CODEX_DOCS_KINDS,
]);

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

/** Every agent kind (the KIND_WORDS keys, so a new kind cannot be missed: the Record is exhaustive). */
export const ALL_AGENT_KINDS: readonly AgentKind[] = Object.keys(KIND_WORDS) as AgentKind[];

/**
 * Can Codex run agents in this version? Only when EVERY kind is ported — so `auto` never picks a
 * provider bound to refuse some run, and `/api/me` never says Codex is available while a Run gate
 * would refuse. FALSE in Phase 2 (the allow-list is empty; only `complete()` runs on Codex).
 */
export function codexRunnable(allow: ReadonlySet<AgentKind> = CODEX_AGENT_KINDS): boolean {
  return ALL_AGENT_KINDS.every((k) => allow.has(k));
}

/** The one sentence a not-yet-ported agent kind answers on Codex. */
export function codexKindNotAvailableMessage(kind: AgentKind): string {
  return `Codex cannot run ${KIND_WORDS[kind] ?? 'this'} in this version of Limn yet. Unset LIMN_AI_PROVIDER (or set it to claude) to use Claude.`;
}

/** Every run kind a pre-flight answers for: every agent kind, then the one-shot `complete`. */
export const ALL_RUN_KINDS: readonly AiRunKind[] = [...ALL_AGENT_KINDS, 'complete'];

/**
 * Can Codex run this RUN kind in this version? The one-shot `complete` always can (its `complete()`
 * runs on Codex); an agent kind only once its stream has ported it. (`allow` is for tests.)
 */
export function codexRunKindReady(kind: AiRunKind, allow: ReadonlySet<AgentKind> = CODEX_AGENT_KINDS): boolean {
  return kind === 'complete' || allow.has(kind);
}

// ---- which provider is active -------------------------------------------------------------------

/**
 * THE `auto` RULE (docs/CODEX-PLAN.md § 6, DECIDED): Claude when both are signed in, Claude when
 * neither is; Codex only when it alone has a credential AND can run. Pure.
 */
export function pickAutoProvider(s: { claudeReady: boolean; codexReady: boolean; codexRunnable: boolean }): 'claude' | 'codex' {
  return s.codexRunnable && s.codexReady && !s.claudeReady ? 'codex' : 'claude';
}

/**
 * What the auto rule reads. ⚠ Codex is ready ONLY on a sign-in KNOWN to be ChatGPT
 * (`codexCredentialRunnable`): the OpenAI API-key route is REFUSED until it can be priced, so a key
 * alone — or a sign-in whose kind no probe has confirmed — must never make auto pick Codex.
 */
export function autoReadiness(env: NodeJS.ProcessEnv = process.env): { claudeReady: boolean; codexReady: boolean; codexRunnable: boolean } {
  return {
    claudeReady: resolveAiCredential(env).route !== 'none',
    codexReady: codexCredentialRunnable(resolveCodexCredential(env)),
    codexRunnable: codexRunnable(),
  };
}

/**
 * THE provider every run and completion uses, per `LIMN_AI_PROVIDER` (read at call time): 'codex'
 * ⇒ Codex, 'claude' ⇒ Claude, 'auto' ⇒ the auto rule (Claude while Codex cannot run every kind). The
 * registry (`ai/provider.ts getActiveProvider`) and the pre-flight (`review/auth.ts`) both ask this.
 */
export function activeProviderId(env: NodeJS.ProcessEnv = process.env): 'claude' | 'codex' {
  const setting = aiProviderSetting(env);
  if (setting === 'codex') return 'codex';
  if (setting === 'claude' || !codexRunnable()) return 'claude';
  return pickAutoProvider(autoReadiness(env));
}
