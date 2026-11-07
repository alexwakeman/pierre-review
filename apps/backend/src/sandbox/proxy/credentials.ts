// THE MODEL CREDENTIAL, KEPT OUT OF THE SANDBOX (docs/SANDBOX.md § Credentials; spike 3, owner decision
// Q4). Shipped mode: INJECTED for both providers.
//
//   • The sandbox holds a per-session PLACEHOLDER and points the CLI at the proxy's injector
//     (`ANTHROPIC_BASE_URL=http://limn-proxy:8081`; Codex's provider `base_url` → `:8082`).
//   • The real credential is read on the HOST, through the same ladder every other run uses
//     (ai/credentials.ts — no caller picks its own), and handed to the proxy's in-memory store over its
//     loopback control port (egress.ts). It is never an env var of any container, never an argv, never
//     a file: `docker inspect` of the proxy shows no secret.
//   • Codex gets an auth.json of the real file's SHAPE whose every secret is fake (unsigned JWTs with
//     only `exp`, `iat` and the auth claim; `refresh_token` = the placeholder). The fake access token's
//     `exp` is the real one's, so Codex never tries to refresh inside the sandbox — a refresh there
//     would rotate the reader's single-use refresh token and sign the host out. The host keeps the real
//     token fresh and the session pushes it again before each turn (`EgressSession.refreshCredentials`).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexHome } from '../../ai/codex/home.js';
import { resolveAiCredential, type AiCredential } from '../../ai/credentials.js';
import type { CredentialMode, SandboxProvider } from './allow-list.js';
import type { ProxyCredentials } from './server.js';

/** Spike 3's verdicts. Changing one is a docs/SANDBOX.md § Credentials change too. */
export const SANDBOX_CREDENTIAL_MODE: Record<SandboxProvider, CredentialMode> = {
  claude: 'injected',
  codex: 'injected',
};

/** The ONE line Settings shows about it. */
export function credentialModeLine(provider: SandboxProvider, mode: CredentialMode = SANDBOX_CREDENTIAL_MODE[provider]): string {
  const who = provider === 'claude' ? 'Claude' : 'ChatGPT';
  return mode === 'injected'
    ? `Your ${who} sign-in stays on this computer. Limn's proxy adds it to each request the agent makes.`
    : `Your ${who} sign-in is copied into the sandbox. Only the allowed hosts can be reached.`;
}

export const PROXY_ALIAS = 'limn-proxy';
export const PROXY_URL = `http://${PROXY_ALIAS}:3128`;
export const ANTHROPIC_INJECTOR_URL = `http://${PROXY_ALIAS}:8081`;
export const CHATGPT_INJECTOR_URL = `http://${PROXY_ALIAS}:8082`;

export function newPlaceholder(): string {
  return `limn-placeholder-${randomBytes(12).toString('hex')}`;
}

// ── what the host holds ─────────────────────────────────────────────────────────────────────────

export type HostClaudeSecret =
  | { kind: 'oauth'; token: string; expiresAt: number | null }
  | { kind: 'api_key'; key: string }
  | { kind: 'none'; reason: string };

interface ClaudeOauthFile {
  claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
}

function oauthFrom(parsed: ClaudeOauthFile | null): HostClaudeSecret | null {
  const token = parsed?.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || token === '') return null;
  const exp = parsed?.claudeAiOauth?.expiresAt;
  return { kind: 'oauth', token, expiresAt: typeof exp === 'number' ? exp : null };
}

/**
 * The Claude Code login's access token on this machine: `CLAUDE_CODE_OAUTH_TOKEN`, else the CLI's
 * credentials file (Linux, or `CLAUDE_CONFIG_DIR`), else the macOS Keychain item the CLI writes.
 */
export function readClaudeLoginToken(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): HostClaudeSecret {
  const fromEnv = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return { kind: 'oauth', token: fromEnv, expiresAt: null };
  const cfg = env.CLAUDE_CONFIG_DIR?.trim();
  for (const file of [...(cfg ? [join(cfg, '.credentials.json')] : []), join(home, '.claude', '.credentials.json'), join(home, '.config', 'claude', '.credentials.json')]) {
    if (!existsSync(file)) continue;
    try {
      const found = oauthFrom(JSON.parse(readFileSync(file, 'utf8')) as ClaudeOauthFile);
      if (found) return found;
    } catch {
      /* unreadable: try the next */
    }
  }
  if (process.platform === 'darwin') {
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 10_000 });
    if (r.status === 0) {
      try {
        const found = oauthFrom(JSON.parse(r.stdout) as ClaudeOauthFile);
        if (found) return found;
      } catch {
        /* not JSON */
      }
    }
  }
  return { kind: 'none', reason: 'Sign in to Claude Code on this computer first.' };
}

/** The credential the sandbox's Claude runs on, per the ONE ladder. */
export function hostClaudeSecret(
  env: NodeJS.ProcessEnv = process.env,
  credential: AiCredential = resolveAiCredential(env),
  readLogin: (env: NodeJS.ProcessEnv) => HostClaudeSecret = readClaudeLoginToken,
): HostClaudeSecret {
  if (credential.route === 'api_key') return { kind: 'api_key', key: credential.apiKey };
  if (credential.route === 'none') return { kind: 'none', reason: 'Sign in to Claude Code, or set ANTHROPIC_API_KEY.' };
  const login = readLogin(env);
  if (login.kind === 'oauth' && login.expiresAt !== null && login.expiresAt < Date.now()) {
    return { kind: 'none', reason: 'Your Claude sign-in has expired. Run any Claude command on this computer to refresh it.' };
  }
  return login;
}

interface CodexAuthFile {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens?: { access_token?: unknown; id_token?: unknown; refresh_token?: unknown; account_id?: unknown };
  last_refresh?: unknown;
  [k: string]: unknown;
}

export function readCodexAuth(env: NodeJS.ProcessEnv = process.env): CodexAuthFile | null {
  const file = join(codexHome(env), 'auth.json');
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as CodexAuthFile) : null;
  } catch {
    return null;
  }
}

/** What the proxy's store gets for a provider. */
export function proxyCredentialsFor(provider: SandboxProvider, env: NodeJS.ProcessEnv = process.env): { creds: ProxyCredentials; problem: string | null } {
  if (provider === 'claude') {
    const s = hostClaudeSecret(env);
    if (s.kind === 'oauth') return { creds: { anthropicOauth: s.token, anthropicApiKey: null }, problem: null };
    if (s.kind === 'api_key') return { creds: { anthropicApiKey: s.key, anthropicOauth: null }, problem: null };
    return { creds: {}, problem: s.reason };
  }
  const access = readCodexAuth(env)?.tokens?.access_token;
  if (typeof access !== 'string' || access === '') return { creds: {}, problem: 'Sign in to ChatGPT in Settings → AI first.' };
  return { creds: { chatgptAccess: access }, problem: null };
}

// ── what the sandbox holds ──────────────────────────────────────────────────────────────────────

/** The Claude CLI's environment in the sandbox: the injector and the placeholder, nothing real. */
export function claudeSandboxEnv(secretKind: 'oauth' | 'api_key', placeholder: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: ANTHROPIC_INJECTOR_URL,
    ...(secretKind === 'oauth' ? { CLAUDE_CODE_OAUTH_TOKEN: placeholder } : { ANTHROPIC_API_KEY: placeholder }),
  };
}

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

function jwtClaims(jwt: unknown): Record<string, unknown> | null {
  if (typeof jwt !== 'string') return null;
  try {
    const v = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const AUTH_CLAIM = 'https://api.openai.com/auth';

/** An unsigned JWT carrying only non-secret claims (`exp`, `iat`, the plan/account claim). */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.limn`;
}

/**
 * The sandbox's Codex auth.json: the real file's shape, every secret fake. Returns the file and the
 * fake access token, which IS the ChatGPT placeholder the injector expects. Null when the host has no
 * ChatGPT sign-in.
 */
export function codexSandboxAuth(real: CodexAuthFile | null, sessionNonce: string): { authJson: string; placeholder: string } | null {
  const access = jwtClaims(real?.tokens?.access_token);
  if (!real || !access) return null;
  const id = jwtClaims(real.tokens?.id_token) ?? {};
  const keep = (c: Record<string, unknown>) => ({ exp: c.exp, iat: c.iat, [AUTH_CLAIM]: c[AUTH_CLAIM], limn: sessionNonce });
  const placeholder = fakeJwt(keep(access));
  const fake = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ ...keep(id), exp: access.exp }),
      access_token: placeholder,
      refresh_token: `limn-placeholder-${sessionNonce}`,
      ...(typeof real.tokens?.account_id === 'string' ? { account_id: real.tokens.account_id } : {}),
    },
    last_refresh: typeof real.last_refresh === 'string' ? real.last_refresh : new Date().toISOString(),
  };
  return { authJson: `${JSON.stringify(fake, null, 2)}\n`, placeholder };
}

/**
 * The provider part of the sandbox's Codex `config.toml` (spike 3). The driver (WP5) adds the
 * lockdown (no plugins, apps, memories, analytics) around it.
 */
export function codexInjectedConfigToml(): string {
  return [
    'cli_auth_credentials_store = "file"',
    'model_provider = "limn"',
    `chatgpt_base_url = "${CHATGPT_INJECTOR_URL}/backend-api/"`,
    '',
    '[model_providers.limn]',
    'name = "OpenAI via Limn"',
    `base_url = "${CHATGPT_INJECTOR_URL}/backend-api/codex"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\n');
}

/**
 * HOW TOOLS IN THE SANDBOX REACH THE INTERNET (spike 4, rule 2). By default there are NO global
 * `HTTP(S)_PROXY` variables: code under test that reads them itself (DEFRA's CDP apps do, and ignore
 * `NO_PROXY`) would send its calls to local services out through the proxy. Each package tool is
 * pointed at the proxy instead, and the agent is told `LIMN_PROXY` for anything else
 * (`curl -x "$LIMN_PROXY" …`). `globalProxyEnv` adds the global variables for a workspace that wants them.
 */
export function sandboxToolProxyEnv(opts: { globalProxyEnv?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {
    LIMN_PROXY: PROXY_URL,
    npm_config_proxy: PROXY_URL,
    npm_config_https_proxy: PROXY_URL,
    YARN_HTTP_PROXY: PROXY_URL,
    YARN_HTTPS_PROXY: PROXY_URL,
    PIP_PROXY: PROXY_URL,
    // git: the proxy, and GitHub over HTTPS (lockfiles name git+ssh URLs; there is no SSH out).
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_CONFIG_VALUE_0: PROXY_URL,
    GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_1: 'ssh://git@github.com/',
    GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_2: 'git@github.com:',
  };
  if (opts.globalProxyEnv) {
    Object.assign(env, {
      HTTP_PROXY: PROXY_URL,
      HTTPS_PROXY: PROXY_URL,
      http_proxy: PROXY_URL,
      https_proxy: PROXY_URL,
      NO_PROXY: `${PROXY_ALIAS},localhost,127.0.0.1`,
      no_proxy: `${PROXY_ALIAS},localhost,127.0.0.1`,
    });
  }
  return env;
}
