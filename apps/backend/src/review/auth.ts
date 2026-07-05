import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getUserAnthropicKey } from './local-settings.js';

// Best-effort detector for whether the Claude Agent SDK has usable credentials.
// The SDK itself exposes no runtime auth option — auth comes from the environment
// or an ambient logged-in Claude Code session. Detection is intentionally fuzzy:
// env vars are reliable, ambient session is a heuristic (we just check for
// plausible config/credential files on disk). If this guesses wrong, the first
// real SDK call surfaces the authoritative auth error, which we report elsewhere;
// this is only a friendly pre-flight, not a hard gate.

export type ClaudeAuthResult =
  | { status: 'ok'; method: 'api_key' | 'oauth_token' | 'ambient' }
  | { status: 'none'; message: string };

// Is an ambient Claude SUBSCRIPTION available (OAuth token or a logged-in Claude
// Code session on disk)? Deliberately excludes API keys — this answers "can Claude
// Review run on the subscription (no per-token billing)?", which drives the
// prefer-ambient policy below.
export function hasAmbientClaudeAuth(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const home = homedir();
  const ambientCandidates = [
    join(home, '.claude', '.credentials.json'),
    join(home, '.config', 'claude', '.credentials.json'),
    join(home, '.claude.json'),
    join(home, '.claude'),
  ];
  return ambientCandidates.some((path) => existsSync(path));
}

export function detectClaudeAuth(): ClaudeAuthResult {
  // Claude Review PREFERS the ambient subscription (see applyClaudeReviewAuth), so
  // report it first when present — even if an API key also exists.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { status: 'ok', method: 'oauth_token' };
  }
  if (hasAmbientClaudeAuth()) {
    return { status: 'ok', method: 'ambient' };
  }

  // No ambient → fall back to an API key (the user's local key, then the env key).
  if (getUserAnthropicKey() || process.env.ANTHROPIC_API_KEY) {
    return { status: 'ok', method: 'api_key' };
  }

  return {
    status: 'none',
    message:
      'No Claude authentication found. Run `claude` once to sign in to an eligible Claude plan (Pro/Max/Team/Enterprise), or set an Anthropic API key, then restart pierre-review.',
  };
}

/**
 * Establish the auth for ONE Claude Review run by mutating process.env, returning a
 * restore fn (always call it in a finally). Policy — Claude Review prefers the
 * ambient subscription so the user's plan/usage credits cover it:
 *
 *   • ambient available → STRIP any ANTHROPIC_API_KEY for the run so the Agent SDK
 *     authenticates via the subscription/OAuth (an API key would otherwise win and
 *     silently meter the run).
 *   • no ambient → fall back to an API key (the user's local key, else the env key).
 *
 * process.env is process-global, so the caller passes `mutate` — the plugin sets it
 * true ONLY when its review concurrency is 1 (the env-race guard); false → no-op and the
 * raw ambient env is used. The Pro summary is unaffected either way — it passes its own
 * key explicitly to the llm seam and never reads this env.
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

  if (hasAmbientClaudeAuth()) {
    // Prefer the subscription: hide any API key so the Agent SDK uses ambient auth.
    if (process.env.ANTHROPIC_API_KEY === undefined) return () => {};
    delete process.env.ANTHROPIC_API_KEY;
    return restore;
  }

  // No ambient → use an API key. A user-supplied local key wins over the env key.
  const key = getUserAnthropicKey();
  if (key) {
    process.env.ANTHROPIC_API_KEY = key;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return restore;
  }
  // Nothing to change — leave any existing ANTHROPIC_API_KEY in place.
  return () => {};
}
