// THE ONE CREDENTIAL LADDER for every model call Limn makes — the agentic runs (Claude Review, AI
// Fix, the ticket / CI reviews, diagrams, sprint paths, the docs build and chat, resolve with
// Claude, every chat) AND the one-shot completions (review/llm.ts `cheapComplete`, which the
// sprint briefs/themes, story labels, docs ranking, sprint Ask Claude and every platform feature —
// reports, synthesis, work-plan wording, pointers, bot themes, the impact note, the advisor's
// refine, the Slack report — all go through).
//
//   1. THE LOCAL CLAUDE CODE LOGIN (default) — a `claude` session on disk or
//      CLAUDE_CODE_OAUTH_TOKEN, used through the Agent SDK. Any ANTHROPIC_API_KEY in the
//      environment is HIDDEN from that run, or the SDK would prefer it and silently meter it.
//   2. ANTHROPIC_API_KEY from the environment — the alternative when there is no login. Agent runs
//      hand it to the Agent SDK; one-shot completions call the Anthropic API directly with it
//      (the SDK loaded through ai/runtime.ts `loadAnthropicSdk`, never imported here).
//
// LIMN_AI_USE_API_KEY=true flips the order when a key is set: the key first, the login ignored.
// LIMN_AI_DISABLED=true (config.aiEnabled) turns every model call off; that switch is checked by
// the callers, not here, because this module answers only "which credential", never "may we".
//
// Nothing is stored. Detection of the login is a heuristic (credential files on disk); a wrong
// guess surfaces as the SDK's own auth error on the first real call.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AiCredential =
  | { route: 'login'; method: 'oauth_token' | 'ambient' }
  | { route: 'api_key'; method: 'api_key'; apiKey: string }
  | { route: 'none' };

/** The opt-in that makes ANTHROPIC_API_KEY win over a Claude Code login. */
export const USE_API_KEY_ENV = 'LIMN_AI_USE_API_KEY';

function envApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const k = env.ANTHROPIC_API_KEY?.trim();
  return k ? k : undefined;
}

/** Does the reader prefer the API key over the login (`LIMN_AI_USE_API_KEY=true`)? */
export function prefersApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[USE_API_KEY_ENV]?.trim().toLowerCase() === 'true';
}

/**
 * Is a Claude Code login available (an OAuth token, or a logged-in session on disk)? Deliberately
 * ignores API keys: it answers "can this run on the reader's own Claude, not a meter?".
 */
export function hasClaudeLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const home = homedir();
  return [
    join(home, '.claude', '.credentials.json'),
    join(home, '.config', 'claude', '.credentials.json'),
    join(home, '.claude.json'),
    join(home, '.claude'),
  ].some((path) => existsSync(path));
}

/** Which credential the next model call uses. Read at call time, so an env change takes effect. */
export function resolveAiCredential(
  env: NodeJS.ProcessEnv = process.env,
  loginAvailable: (env: NodeJS.ProcessEnv) => boolean = hasClaudeLogin,
): AiCredential {
  const apiKey = envApiKey(env);
  if (apiKey && prefersApiKey(env)) return { route: 'api_key', method: 'api_key', apiKey };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { route: 'login', method: 'oauth_token' };
  if (loginAvailable(env)) return { route: 'login', method: 'ambient' };
  if (apiKey) return { route: 'api_key', method: 'api_key', apiKey };
  return { route: 'none' };
}

/**
 * The environment an Agent SDK subprocess runs with, per the ladder. Passed as the query's `env`
 * option, so it never touches process.env and two concurrent runs cannot race.
 *
 *   • login → the inherited environment WITHOUT ANTHROPIC_API_KEY (the login pays, not a meter).
 *   • API key → the inherited environment WITHOUT CLAUDE_CODE_OAUTH_TOKEN, so the key is used.
 *   • none → the inherited environment unchanged; the SDK reports the authoritative auth error.
 */
export function agentSdkEnv(
  env: NodeJS.ProcessEnv = process.env,
  credential: AiCredential = resolveAiCredential(env),
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  if (credential.route === 'login') delete out.ANTHROPIC_API_KEY;
  else if (credential.route === 'api_key') {
    delete out.CLAUDE_CODE_OAUTH_TOKEN;
    out.ANTHROPIC_API_KEY = credential.apiKey;
  }
  return out;
}

/** Spread into every Agent SDK `query({ options })`, beside `claudeExecutableOptions()`. */
export function agentAuthOptions(): { env: Record<string, string | undefined> } {
  return { env: agentSdkEnv() };
}
