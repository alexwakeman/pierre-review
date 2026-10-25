import type { AiRunKind } from '@pierre-review/shared';
import { hasClaudeLogin, resolveAiCredential } from '../ai/credentials.js';
import { codexDetailCached, NO_CODEX_AUTH_MESSAGE } from '../ai/codex/detect.js';
import {
  activeProviderId,
  CODEX_NOT_AVAILABLE_MESSAGE,
  codexKindNotAvailableMessage,
  codexRunKindReady,
  codexRunnable,
} from '../ai/provider-setting.js';

// The pre-flight view of the ONE credential ladder (ai/credentials.ts): the reader's Claude Code
// login first, else ANTHROPIC_API_KEY (or the key first under LIMN_AI_USE_API_KEY=true). Detection
// reads the disk (a credentials file, or `oauthAccount` in the Claude config — never a bare
// `~/.claude`, which any run creates). If it guesses
// wrong, the first real call surfaces the authoritative auth error; this is only a friendly
// pre-flight, not a hard gate.

export type ClaudeAuthResult =
  | { status: 'ok'; method: 'api_key' | 'oauth_token' | 'ambient' | 'chatgpt' }
  | { status: 'none'; message: string };

/** Is a Claude Code login available? (Kept under its historical name; see ai/credentials.ts.) */
export function hasAmbientClaudeAuth(): boolean {
  return hasClaudeLogin();
}

export const NO_CLAUDE_AUTH_MESSAGE = 'Sign in to Claude Code or set ANTHROPIC_API_KEY';

/**
 * THE PRE-FLIGHT, PER RUN KIND (the name is historical: it answers for the ACTIVE provider).
 *
 * `kind` names what is about to run: an agent kind, or `'complete'` for a one-shot feature (sprint
 * briefs and themes, story labels, the sprint "Ask", the platform's `ctx.llm`). On CLAUDE every kind
 * gets the same answer (the credential ladder). On CODEX (`LIMN_AI_PROVIDER=codex`, or `auto` once it
 * can run every kind):
 *   • a kind Codex can run (`complete`, or an agent kind in `CODEX_AGENT_KINDS`) is 'ok' when Codex is
 *     installed AND signed in with ChatGPT (`codexDetailCached().runnable` — the API-key route and a
 *     sign-in of unknown kind are refused), else 'none' with Codex's own sentence;
 *   • any other agent kind is 'none' with "Codex cannot run … yet" — so its Run gate shows that
 *     sentence instead of a button bound to fail, and its background sweeper (`agenticRunReady`)
 *     waits instead of starting a doomed run;
 *   • NO kind means "any agent": 'none' with "Codex is not available …" until EVERY kind can run.
 * Cached reads only: nothing here waits on a process.
 */
export function detectClaudeAuth(kind?: AiRunKind): ClaudeAuthResult {
  if (activeProviderId() === 'codex') return detectCodexAuth(kind);
  const c = resolveAiCredential();
  if (c.route !== 'none') return { status: 'ok', method: c.method };
  // ⚠ THIS SENTENCE IS RENDERED IN THE SPA, NOT JUST LOGGED — it is the ONE line that replaces
  // every Run button when no credential is found (`MeResponse.ai.authMessage` and the routes'
  // `authMessage`). Plain and short, and it promises no plan or billing: Limn stores no key and
  // charges nothing; the run uses the user's own Claude Code sign-in or API key.
  return { status: 'none', message: NO_CLAUDE_AUTH_MESSAGE };
}

/** The Codex half of the pre-flight (see `detectClaudeAuth`). */
function detectCodexAuth(kind: AiRunKind | undefined): ClaudeAuthResult {
  if (kind === undefined) {
    if (!codexRunnable()) return { status: 'none', message: CODEX_NOT_AVAILABLE_MESSAGE };
  } else if (!codexRunKindReady(kind)) {
    return { status: 'none', message: codexKindNotAvailableMessage(kind as Exclude<AiRunKind, 'complete'>) };
  }
  const d = codexDetailCached();
  return d.runnable ? { status: 'ok', method: 'chatgpt' } : { status: 'none', message: d.message ?? NO_CODEX_AUTH_MESSAGE };
}

/**
 * Establish the auth for ONE agent run by mutating process.env, returning a restore fn (always
 * call it in a finally). Every Agent SDK query ALSO passes the ladder's environment explicitly
 * (`agentAuthOptions()`), which is what actually decides the credential and cannot race; this
 * keeps process.env consistent with it for anything else the run spawns.
 *
 *   • login → STRIP any ANTHROPIC_API_KEY for the run so the SDK uses the login (an API key would
 *     otherwise win and silently meter the run).
 *   • API key (no login, or LIMN_AI_USE_API_KEY=true) → strip CLAUDE_CODE_OAUTH_TOKEN so the key
 *     is used; the key itself is left where it is.
 *   • nothing → no-op.
 *
 * process.env is process-global, so the caller passes `mutate` — true ONLY when no other run can
 * share the env; false → no-op.
 */
export function applyClaudeReviewAuth(mutate: boolean): () => void {
  if (!mutate) return () => {};

  const prevApiKey = process.env.ANTHROPIC_API_KEY;
  const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const restore = (): void => {
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApiKey;
    if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth;
  };

  const c = resolveAiCredential();
  if (c.route === 'login') {
    if (prevApiKey === undefined) return () => {};
    delete process.env.ANTHROPIC_API_KEY;
    return restore;
  }
  if (c.route === 'api_key') {
    if (prevOauth === undefined) return () => {};
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return restore;
  }
  return () => {};
}
