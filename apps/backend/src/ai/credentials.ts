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
// Nothing is stored. Detection of the login reads the disk (a credentials file, or `oauthAccount`
// recorded in the Claude config — see hasClaudeLogin); a wrong
// guess surfaces as the SDK's own auth error on the first real call.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexSignedInCached } from './codex/app-server.js';
import { codexHome } from './codex/home.js';

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
 * Does this Claude Code config file record a signed-in account? The CLI writes a non-empty
 * `oauthAccount` object on sign-in and removes it on logout — on macOS, where the token itself is
 * in the Keychain, it is the only on-disk signal. A missing, unreadable or unparseable file is no.
 */
function configRecordsLogin(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return false;
    const account = (parsed as { oauthAccount?: unknown }).oauthAccount;
    return !!account && typeof account === 'object' && Object.keys(account).length > 0;
  } catch {
    return false;
  }
}

/**
 * Is a Claude Code login available (an OAuth token, or a logged-in session on disk)? Deliberately
 * ignores API keys: it answers "can this run on the reader's own Claude, not a meter?".
 *
 * ⚠ A BARE `~/.claude` DIRECTORY OR `~/.claude.json` IS NOT A LOGIN. Merely running Claude Code —
 * including the Agent SDK on the API-key route — creates both, so counting them moved a key-only
 * reader onto the login route after their first run and stripped their key from every later one.
 * Only a credentials file, CLAUDE_CODE_OAUTH_TOKEN, or a config recording `oauthAccount` counts.
 * CLAUDE_CONFIG_DIR (which the SDK subprocess inherits) is checked before the defaults.
 */
export function hasClaudeLogin(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): boolean {
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  const cfg = env.CLAUDE_CONFIG_DIR?.trim();
  const credentialFiles = [
    ...(cfg ? [join(cfg, '.credentials.json')] : []),
    join(home, '.claude', '.credentials.json'),
    join(home, '.config', 'claude', '.credentials.json'),
  ];
  if (credentialFiles.some((path) => existsSync(path))) return true;
  const configFiles = [...(cfg ? [join(cfg, '.claude.json')] : []), join(home, '.claude.json')];
  return configFiles.some(configRecordsLogin);
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

// ---- Codex (docs/CODEX-PLAN.md § 3.7) -------------------------------------------------------------
//
// THE SAME TWO RUNGS, for Codex:
//   1. THE CODEX SIGN-IN IN LIMN'S OWN HOME (`~/.limn/codex`, `limn ai login codex`) — a ChatGPT plan
//      pays, measured by the token-weighted share of its windows (ai/budget.ts). Read from the cached
//      `account/read` (ai/codex/app-server.ts); before the first read, from `auth.json` being there
//      (a heuristic like Claude's disk check — the background probe corrects it within seconds).
//   2. OPENAI_API_KEY from the environment, handed to the run as CODEX_API_KEY. NEVER STORED: Limn does
//      not run `codex login --with-api-key` (that would write the key into its home).
// LIMN_AI_USE_API_KEY=true flips the order, as for Claude. A key the reader stored in Limn's home by
// hand (`CODEX_HOME=~/.limn/codex codex login --with-api-key`) counts as the API-key rung.
//
// ⚠ The reader's own `~/.codex` is never consulted: its sign-in is not Limn's.

export type CodexCredential =
  | { route: 'login'; method: 'chatgpt' }
  | { route: 'api_key'; method: 'api_key'; apiKey: string }
  | { route: 'api_key'; method: 'stored_api_key' }
  | { route: 'none' };

/** What the sign-in check knows: the cached `account/read`, else whether auth.json is there. */
export interface CodexLoginKnown {
  signedIn: boolean;
  /** 'chatgpt' | 'apiKey' | another kind | null when not read yet. */
  type: string | null;
}

function codexEnvApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const k = env.OPENAI_API_KEY?.trim();
  return k ? k : undefined;
}

/** The sign-in in Limn's Codex home: the cached account read, else the disk heuristic. Sync. */
export function codexLoginKnown(env: NodeJS.ProcessEnv = process.env): CodexLoginKnown {
  const cached = codexSignedInCached();
  if (cached) return { signedIn: cached.signedIn, type: cached.type };
  return existsSync(join(codexHome(env), 'auth.json'))
    ? { signedIn: true, type: null }
    : { signedIn: false, type: null };
}

/** Which credential the next Codex run uses. Read at call time. */
export function resolveCodexCredential(
  env: NodeJS.ProcessEnv = process.env,
  login: (env: NodeJS.ProcessEnv) => CodexLoginKnown = codexLoginKnown,
): CodexCredential {
  const apiKey = codexEnvApiKey(env);
  if (apiKey && prefersApiKey(env)) return { route: 'api_key', method: 'api_key', apiKey };
  const known = login(env);
  if (known.signedIn && known.type === 'apiKey') return { route: 'api_key', method: 'stored_api_key' };
  if (known.signedIn) return { route: 'login', method: 'chatgpt' };
  if (apiKey) return { route: 'api_key', method: 'api_key', apiKey };
  return { route: 'none' };
}

/**
 * The environment a Codex RUN gets: CODEX_HOME = Limn's home, and per the ladder —
 *   • login / a stored key → every API-key variable REMOVED, so the sign-in pays, never a meter;
 *   • API key → CODEX_API_KEY = the key (`codex exec` reads it), OPENAI_API_KEY removed;
 *   • none → no key either; Codex reports its own auth error.
 */
export function codexRunEnv(
  env: NodeJS.ProcessEnv = process.env,
  credential: CodexCredential = resolveCodexCredential(env),
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, CODEX_HOME: codexHome(env) };
  delete out.OPENAI_API_KEY;
  delete out.CODEX_API_KEY;
  if (credential.route === 'api_key' && credential.method === 'api_key') out.CODEX_API_KEY = credential.apiKey;
  return out;
}
