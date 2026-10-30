// THE ONE CREDENTIAL LADDER for every model call Limn makes — the agentic runs (Claude Review, AI
// Fix, the ticket / CI reviews, diagrams, sprint paths, the docs build and chat, resolve with
// Claude, every chat) AND the one-shot completions (review/llm.ts `cheapComplete`, which the
// sprint briefs/themes, story labels, docs ranking, sprint Ask Claude and every platform feature —
// reports, synthesis, work-plan wording, pointers, bot themes, the Slack
// report — all go through).
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
//      `account/read` (ai/codex/app-server.ts); before the first read, from auth.json's NON-SECRET
//      `auth_mode` (and whether its API-key field is filled in — the value is never read out).
//   2. OPENAI_API_KEY from the environment, handed to the run as CODEX_API_KEY. NEVER STORED: Limn does
//      not run `codex login --with-api-key` (that would write the key into its home).
// A key the reader stored in Limn's home by hand (`CODEX_HOME=~/.limn/codex codex login --with-api-key`)
// counts as the API-key rung — and Codex ITSELF refuses it while that rung is refused:
// `forced_login_method = "chatgpt"` is in the lockdown (ai/codex/config.ts `LOCKED_SETTINGS`), so
// `codex exec` stops before any request ("ChatGPT login is required, but an API key is currently being
// used. Logging out." — and it deletes that auth.json), and `account/read` answers signed out.
//
// ⚠ FAIL CLOSED. Only a sign-in KNOWN to be ChatGPT may run (`codexCredentialRunnable`). The API-key
// route is refused until it can be priced (ai/codex/detect.ts), so a stored key taken for "a sign-in"
// would run and be recorded at US$ 0 under no cap. A sign-in whose kind is not known yet (no probe has
// answered and auth.json does not say) is `method: 'unconfirmed'`: never runnable — the run path waits
// for one fresh `account/read` first (ai/providers/codex.ts `runnableCredential`).
//
// ⚠ LIMN_AI_USE_API_KEY=true (shared with Claude) does NOT push a ChatGPT sign-in onto the key route
// while that route is refused: the sign-in is consulted first. Without one, the flag still puts
// OPENAI_API_KEY ahead of a key stored in the home.
//
// ⚠ The reader's own `~/.codex` is never consulted: its sign-in is not Limn's.

export type CodexCredential =
  | { route: 'login'; method: 'chatgpt' }
  /** auth.json is there but its kind is not known yet: NEVER runnable (see the header). */
  | { route: 'login'; method: 'unconfirmed' }
  | { route: 'api_key'; method: 'api_key'; apiKey: string }
  | { route: 'api_key'; method: 'stored_api_key' }
  | { route: 'none' };

/** The ONE runnable Codex credential: a sign-in KNOWN to be ChatGPT. Everything else is refused. */
export function codexCredentialRunnable(c: CodexCredential): c is { route: 'login'; method: 'chatgpt' } {
  return c.route === 'login' && c.method === 'chatgpt';
}

/** What the sign-in check knows: the cached `account/read`, else what auth.json says. */
export interface CodexLoginKnown {
  signedIn: boolean;
  /** 'chatgpt' | 'apiKey' | another kind | null when not known (not read yet, or not readable). */
  type: string | null;
}

function codexEnvApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const k = env.OPENAI_API_KEY?.trim();
  return k ? k : undefined;
}

/**
 * The KIND of sign-in an auth.json in Limn's home holds, from its NON-SECRET fields only: `auth_mode`
 * (0.164 writes `chatgpt` or `apikey`) and whether `OPENAI_API_KEY` is filled in (the value is never
 * read out, logged or returned). Fail closed — anything not clearly one kind is null ("not known"):
 *   • `auth_mode: "apikey"`, or no `auth_mode` and a filled-in key → 'apiKey' (Codex's own default);
 *   • `auth_mode: "chatgpt"` with NO key filled in → 'chatgpt';
 *   • unreadable, unparseable, another mode, or chatgpt WITH a key → null.
 */
export function codexAuthFileKind(path: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as { auth_mode?: unknown; OPENAI_API_KEY?: unknown };
  const hasKey = typeof rec.OPENAI_API_KEY === 'string' && rec.OPENAI_API_KEY.trim() !== '';
  if (rec.auth_mode === undefined || rec.auth_mode === null) return hasKey ? 'apiKey' : null;
  if (typeof rec.auth_mode !== 'string') return null;
  const mode = rec.auth_mode.trim().toLowerCase();
  if (mode === 'apikey') return 'apiKey';
  if (mode === 'chatgpt') return hasKey ? null : 'chatgpt';
  return null;
}

/** The sign-in in Limn's Codex home: the cached account read, else auth.json's kind. Sync. */
export function codexLoginKnown(env: NodeJS.ProcessEnv = process.env): CodexLoginKnown {
  const cached = codexSignedInCached();
  if (cached) return { signedIn: cached.signedIn, type: cached.type };
  const path = join(codexHome(env), 'auth.json');
  return existsSync(path) ? { signedIn: true, type: codexAuthFileKind(path) } : { signedIn: false, type: null };
}

/**
 * Does auth.json in Limn's home still say what the CACHED `account/read` says? Checked before every
 * run (ai/providers/codex.ts `runnableCredential`), because after the first read `codexLoginKnown`
 * trusts the cache over the file: a sign-out, or a key stored by hand in the home since the last probe
 * (`codex login --with-api-key`), would otherwise ride the cached "ChatGPT" until the next probe.
 *
 * Only a KNOWN disagreement counts — auth.json gone while the cache says signed in, or auth.json's kind
 * known (`codexAuthFileKind`) and different from the cached type. A file whose kind is not known (null)
 * leaves the probe's answer standing: the probe is the authority there. No cached read ⇒ true (the
 * ladder already reads the file).
 */
export function codexAuthFileAgreesWithCache(env: NodeJS.ProcessEnv = process.env): boolean {
  const cached = codexSignedInCached();
  if (!cached) return true;
  const path = join(codexHome(env), 'auth.json');
  if (!existsSync(path)) return !cached.signedIn;
  const kind = codexAuthFileKind(path);
  // Cached as signed out: only a ChatGPT sign-in written since disagrees. (A stored key reads as signed
  // out under `forced_login_method = "chatgpt"` — config.ts LOCKED_SETTINGS — and is no disagreement.)
  if (!cached.signedIn) return kind !== 'chatgpt';
  return kind === null || kind === cached.type;
}

/** Which credential the next Codex run uses. Read at call time. */
export function resolveCodexCredential(
  env: NodeJS.ProcessEnv = process.env,
  login: (env: NodeJS.ProcessEnv) => CodexLoginKnown = codexLoginKnown,
): CodexCredential {
  const apiKey = codexEnvApiKey(env);
  const known = login(env);
  // The sign-in FIRST, whatever LIMN_AI_USE_API_KEY says: the key route is refused (see the header).
  if (known.signedIn && known.type === 'chatgpt') return { route: 'login', method: 'chatgpt' };
  if (known.signedIn && known.type === null) return { route: 'login', method: 'unconfirmed' };
  if (apiKey && prefersApiKey(env)) return { route: 'api_key', method: 'api_key', apiKey };
  if (known.signedIn && known.type === 'apiKey') return { route: 'api_key', method: 'stored_api_key' };
  // Another kind of sign-in (neither ChatGPT nor a key) pays for nothing Limn can run on: not a rung.
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
