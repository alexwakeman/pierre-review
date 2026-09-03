import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

  // No ambient → the environment's API key, and nothing else. ⚠ THE STORED BYO KEY RUNG IS
  // GONE: `~/.pierre-review/config.json`'s `anthropicApiKey` is retired and never read, so
  // this detector must report from the env var ALONE — reporting `ok` off a value no run can
  // use would be a green pre-flight in front of a guaranteed auth failure.
  if (process.env.ANTHROPIC_API_KEY) {
    return { status: 'ok', method: 'api_key' };
  }

  return {
    status: 'none',
    message:
      'No Claude authentication found. Run `claude` once to sign in to an eligible Claude plan (Pro/Max/Team/Enterprise), or set ANTHROPIC_API_KEY in the environment before starting, then restart pierre-review.',
  };
}

/**
 * Establish the auth for ONE Claude Review run by mutating process.env, returning a
 * restore fn (always call it in a finally). Policy — Claude Review prefers the
 * ambient subscription so the user's plan/usage credits cover it.
 *
 * ⚠ THE LADDER IS TWO RUNGS, NOT THREE. The middle rung — a BYO Anthropic key stored in
 * `~/.pierre-review/config.json` — is RETIRED, along with its form and its routes:
 *
 *   • ambient available → STRIP any ANTHROPIC_API_KEY for the run so the Agent SDK
 *     authenticates via the subscription/OAuth (an API key would otherwise win and
 *     silently meter the run). UNCHANGED, and load-bearing: this is what makes a
 *     subscription pay instead of a meter.
 *   • no ambient → leave the environment EXACTLY as it is, so an operator-set
 *     ANTHROPIC_API_KEY is used by the SDK. Nothing is written into process.env on this
 *     path any more, which is why it returns a no-op restore.
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

  // No ambient → nothing to establish. Any existing ANTHROPIC_API_KEY stays exactly where it
  // is and the Agent SDK picks it up; with no key either, the first SDK call surfaces the
  // authoritative auth error, which is what `detectClaudeAuth` pre-empts on screen.
  return () => {};
}
