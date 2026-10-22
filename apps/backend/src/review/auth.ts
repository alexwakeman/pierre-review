import { hasClaudeLogin, resolveAiCredential } from '../ai/credentials.js';

// The pre-flight view of the ONE credential ladder (ai/credentials.ts): the reader's Claude Code
// login first, else ANTHROPIC_API_KEY (or the key first under LIMN_AI_USE_API_KEY=true). Detection
// is intentionally fuzzy — the login is a heuristic (credential files on disk). If it guesses
// wrong, the first real call surfaces the authoritative auth error; this is only a friendly
// pre-flight, not a hard gate.

export type ClaudeAuthResult =
  | { status: 'ok'; method: 'api_key' | 'oauth_token' | 'ambient' }
  | { status: 'none'; message: string };

/** Is a Claude Code login available? (Kept under its historical name; see ai/credentials.ts.) */
export function hasAmbientClaudeAuth(): boolean {
  return hasClaudeLogin();
}

export const NO_CLAUDE_AUTH_MESSAGE = 'Sign in to Claude Code or set ANTHROPIC_API_KEY';

export function detectClaudeAuth(): ClaudeAuthResult {
  const c = resolveAiCredential();
  if (c.route !== 'none') return { status: 'ok', method: c.method };
  // ⚠ THIS SENTENCE IS RENDERED IN THE SPA, NOT JUST LOGGED — it is the ONE line that replaces
  // every Run button when no credential is found (`MeResponse.ai.authMessage` and the routes'
  // `authMessage`). Plain and short, and it promises no plan or billing: Limn stores no key and
  // charges nothing; the run uses the user's own Claude Code sign-in or API key.
  return { status: 'none', message: NO_CLAUDE_AUTH_MESSAGE };
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
