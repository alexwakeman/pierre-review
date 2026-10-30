// THE `LIMN_AI_PROVIDER` SETTING, on its own so the pre-flight (`review/auth.ts` `detectClaudeAuth`)
// can read it without importing the provider registry (`ai/provider.ts` → `providers/claude.ts` →
// `review/auth.ts` would be a cycle). `ai/provider.ts` re-exports all of it. Also here, for the same
// reason: WHICH provider is active (`activeProviderId`, the `auto` rule) and which agent kinds Codex
// may run (`CODEX_AGENT_KINDS`, the union of the four Phase 3 streams' own files).

import { isAiProviderSetting, type AiProviderSetting, type AiRunKind } from '@pierre-review/shared';
import { codexCredentialRunnable, resolveAiCredential, resolveCodexCredential } from './credentials.js';
import { CODEX_DOCS_KINDS } from './codex/kinds/docs.js';
import { CODEX_FIX_KINDS } from './codex/kinds/fix.js';
import { CODEX_REVIEW_KINDS } from './codex/kinds/review.js';
import { CODEX_STORY_BUILD_KINDS } from './codex/kinds/story-build.js';
import { CODEX_TICKETS_KINDS } from './codex/kinds/tickets.js';
import type { AgentKind } from './provider.js';

export const AI_PROVIDER_ENV = 'LIMN_AI_PROVIDER';

export type { AiProviderSetting };

/**
 * Codex cannot run every agent kind in this build (`codexRunnable()` false). Unreachable while every
 * kind is ported (Phase 3 complete); kept for a build that ships a kind Codex cannot run yet.
 */
export const CODEX_NOT_AVAILABLE_MESSAGE =
  'Codex cannot run every AI feature in this version of Limn. Choose Claude in Settings → AI.';

// ---- the choice: LIMN_AI_PROVIDER, else Settings → AI (docs/CODEX-PLAN.md Phase 4) ---------------
//
// ONE resolver, `aiProviderSetting()`: an explicitly set `LIMN_AI_PROVIDER` (claude | codex | auto) WINS;
// otherwise the choice stored per machine (`accounts.ai_provider`, written by PUT /api/ai/provider),
// default `auto`. The stored value is held HERE, in memory, so every run asks synchronously: the boot
// loads it (ai/provider-store.ts `loadStoredAiProvider`) and the route updates it on write. A switch
// therefore reaches the NEXT run without a restart; a run already going keeps the provider it picked.
// (No DB import here: the pre-flight reads this module, and the DB client opens the file at import.)

let storedSetting: AiProviderSetting | null = null;

/** The stored choice (Settings → AI), or null when none is stored. Memory only; see the header. */
export function storedAiProviderSetting(): AiProviderSetting | null {
  return storedSetting;
}

/** Hold the stored choice in memory (the boot's load, the route's write, tests). null ⇒ none stored. */
export function setStoredAiProviderSetting(value: AiProviderSetting | null): void {
  storedSetting = value;
}

/** `LIMN_AI_PROVIDER` when it is set to a known value; null when unset, empty or unknown. */
export function aiProviderEnvSetting(env: NodeJS.ProcessEnv = process.env): AiProviderSetting | null {
  const raw = env[AI_PROVIDER_ENV]?.trim().toLowerCase();
  return isAiProviderSetting(raw) ? raw : null;
}

/** THE provider choice, read at call time: `LIMN_AI_PROVIDER` when set, else the stored one, else 'auto'. */
export function aiProviderSetting(env: NodeJS.ProcessEnv = process.env): AiProviderSetting {
  return aiProviderEnvSetting(env) ?? storedSetting ?? 'auto';
}

/** The choice and who made it (`MeResponse.ai.providerSetting`). */
export function aiProviderSettingStatus(env: NodeJS.ProcessEnv = process.env): { value: AiProviderSetting; source: 'env' | 'settings' } {
  const fromEnv = aiProviderEnvSetting(env);
  return fromEnv ? { value: fromEnv, source: 'env' } : { value: storedSetting ?? 'auto', source: 'settings' };
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
  // "Implement story" (listed from its contract commit — see that file's header).
  ...CODEX_STORY_BUILD_KINDS,
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
  story_plan: 'story plans',
  story_build: 'story builds',
};

/** Every agent kind (the KIND_WORDS keys, so a new kind cannot be missed: the Record is exhaustive). */
export const ALL_AGENT_KINDS: readonly AgentKind[] = Object.keys(KIND_WORDS) as AgentKind[];

/**
 * Can Codex run agents in this version? Only when EVERY kind is ported — so `auto` never picks a
 * provider bound to refuse some run, and `/api/me` never says Codex is available while a Run gate
 * would refuse. TRUE since Phase 3 completed: every kind is ported (docs/CODEX-PLAN.md § Phase 3).
 */
export function codexRunnable(allow: ReadonlySet<AgentKind> = CODEX_AGENT_KINDS): boolean {
  return ALL_AGENT_KINDS.every((k) => allow.has(k));
}

/**
 * The remedy when Codex cannot run something: pick Claude where the choice was made — Settings → AI,
 * or `LIMN_AI_PROVIDER` when that is what chose Codex. Read at call time.
 */
function chooseClaudeSentence(): string {
  return aiProviderEnvSetting() ? 'Set LIMN_AI_PROVIDER to claude to use Claude.' : 'Choose Claude in Settings → AI.';
}

/** The one sentence a not-yet-ported agent kind answers on Codex. */
export function codexKindNotAvailableMessage(kind: AgentKind): string {
  return `Codex cannot run ${KIND_WORDS[kind] ?? 'this'} in this version of Limn yet. ${chooseClaudeSentence()}`;
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
