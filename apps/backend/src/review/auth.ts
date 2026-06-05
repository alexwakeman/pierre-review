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

export function detectClaudeAuth(): ClaudeAuthResult {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.length > 0) {
    return { status: 'ok', method: 'api_key' };
  }

  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken && oauthToken.length > 0) {
    return { status: 'ok', method: 'oauth_token' };
  }

  // Ambient logged-in Claude Code session: any of these on disk is good enough.
  // The last two are weak signals (config dir present, but maybe not signed in) —
  // a wrong guess just means the run fails with a clear SDK auth error.
  const home = homedir();
  const ambientCandidates = [
    join(home, '.claude', '.credentials.json'),
    join(home, '.config', 'claude', '.credentials.json'),
    join(home, '.claude.json'),
    join(home, '.claude'),
  ];
  if (ambientCandidates.some((path) => existsSync(path))) {
    return { status: 'ok', method: 'ambient' };
  }

  return {
    status: 'none',
    message:
      'No Claude authentication found. Set ANTHROPIC_API_KEY, or run `claude` once to sign in to an eligible Claude plan (Pro/Max/Team/Enterprise), then restart pierre-review.',
  };
}
