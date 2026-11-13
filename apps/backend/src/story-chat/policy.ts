// STORY CHAT — WHAT THE AGENT'S SHELL MAY TOUCH (docs/STORY-CHAT.md § The sandbox). Pure, except
// `sandboxSupport`, which looks at the host once and caches the answer.
//
// Each rule here answers a finding of the spike (docs/QUICK-CHAT-SPIKE.md § Findings):
//   1. srt passes the agent's environment to every command → `agentEnv` is an ALLOW-LIST, and the
//      model credential is also removed from commands (`DENY_ENV`, the SDK's credentials rule);
//   2. srt keeps its proxy sockets under TMPDIR (Unix socket paths ≤ ~108 bytes) → a SHORT temp root;
//   3. the host's NO_PROXY sends an allowed host around srt's proxy → those hosts are taken out of it;
//   4. reads deny the home folder, so a CA bundle kept there must be allowed by path → `caReadPaths`;
//   5. borrowed node_modules are read-only → the seed tells the agent to put caches in $TMPDIR.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentSandboxPolicy } from '../ai/provider.js';
import { DEFAULT_ALLOWED_HOSTS } from '../sandbox/proxy/allow-list.js';

/** The model credential: never visible to a command (the agent process itself keeps it). */
export const DENY_ENV: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

/** Exact names the agent process keeps. */
const KEEP_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TZ',
  'COLORTERM',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'CLAUDE_CONFIG_DIR',
  // Claude Code's own "this host is already a container" flag (it then allows bypassPermissions as root).
  'IS_SANDBOX',
  // The credential ladder's own variables (ai/credentials.ts); DENY_ENV keeps them out of commands.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]);
/** Prefixes the agent process keeps (locale, XDG folders). */
const KEEP_PREFIX = ['LC_', 'XDG_'];

/** A host list entry matches an allowed domain (exact, `.suffix` or `*.suffix`). */
function noProxyEntryCovers(entry: string, domain: string): boolean {
  const e = entry.trim().toLowerCase().replace(/^\*\./, '.');
  const d = domain.toLowerCase().replace(/^\*\./, '');
  if (e === '' || e === '*') return e === '*';
  if (e.startsWith('.')) return d === e.slice(1) || d.endsWith(e);
  return d === e;
}

/** NO_PROXY without the entries that would send an allowed domain around the sandbox's proxy. Pure. */
export function trimNoProxy(value: string, allowedDomains: readonly string[]): string {
  return value
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '' && !allowedDomains.some((d) => noProxyEntryCovers(x, d)))
    .join(',');
}

/** The agent process's environment: an ALLOW-LIST of the server's, plus TMPDIR. Pure. */
export function agentEnv(env: NodeJS.ProcessEnv, opts: { tmpDir: string; allowedDomains: readonly string[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (KEEP_EXACT.has(k) || KEEP_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  for (const k of ['NO_PROXY', 'no_proxy']) {
    const v = env[k];
    if (v == null) continue;
    const t = trimNoProxy(v, opts.allowedDomains);
    if (t !== '') out[k] = t;
  }
  out.TMPDIR = opts.tmpDir;
  return out;
}

/** The CA files the environment names, and their folders (a home-folder CA must be readable). Pure but for existsSync. */
export function caReadPaths(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const k of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_DIR']) {
    const v = env[k];
    if (!v || !v.startsWith('/')) continue;
    out.add(k === 'SSL_CERT_DIR' ? v : dirname(v));
  }
  return [...out].filter((p) => existsSync(p));
}

/** The registries and hosts a command may reach: the build sandbox's defaults plus the workspace's own. Pure. */
export function chatAllowedDomains(workspaceRules: readonly string[]): string[] {
  return [...new Set([...DEFAULT_ALLOWED_HOSTS.map((h) => h.rule), ...workspaceRules])];
}

export interface ChatCheckoutPaths {
  /** The worktree. */
  path: string;
  /** The clone's shared git folder (objects, refs): read only. */
  commonDir: string | null;
  /** This worktree's own git folder (index, HEAD): written by `git status` and friends. */
  gitDir: string | null;
}

/** Realpath when it exists (macOS: /tmp is /private/tmp; srt matches literal paths on Linux). */
export function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The shell's sandbox for one chat. Pure but for realpath. */
export function chatSandboxPolicy(a: {
  home: string;
  checkouts: readonly ChatCheckoutPaths[];
  /** Borrowed read-only folders (the reader's node_modules). */
  borrowed: readonly string[];
  tmpDir: string;
  extraRead: readonly string[];
  allowedDomains: readonly string[];
}): AgentSandboxPolicy {
  const uniq = (xs: Array<string | null>): string[] => [...new Set(xs.filter((x): x is string => x != null).map(real))];
  const tmp = real(a.tmpDir);
  return {
    // Reads: everything but the home folder (where the clone cache, the reader's clones and every
    // credential live), and back inside it only what the chat needs.
    denyRead: [real(a.home)],
    allowRead: uniq([...a.checkouts.flatMap((c) => [c.path, c.commonDir, c.gitDir]), ...a.borrowed, tmp, ...a.extraRead]),
    allowWrite: uniq([...a.checkouts.flatMap((c) => [c.path, c.gitDir]), tmp]),
    // The borrowed folders stay read-only even where they sit inside a checkout (they are links into it).
    denyWrite: uniq([...a.borrowed]),
    allowedDomains: [...a.allowedDomains],
    denyEnv: [...DENY_ENV],
  };
}

/** The chat's temp root: SHORT (finding 2). `/tmp` on macOS and Linux, else the system's. Pure. */
export function chatTmpBase(platform: NodeJS.Platform, systemTmp: string, hasSlashTmp: boolean): string {
  return (platform === 'linux' || platform === 'darwin') && hasSlashTmp ? '/tmp' : systemTmp;
}

/** Prefix of every chat temp folder of THIS install (a short hash of the data folder). Pure. */
export function chatTmpPrefix(dataDir: string): string {
  let h = 0;
  for (const ch of dataDir) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `limn-q-${(h >>> 0).toString(36).slice(0, 5)}-`;
}

export const CHAT_TMP_MAX_PATH = 60;

// ---- can commands run here? ---------------------------------------------------------------------

export interface SandboxSupport {
  ok: boolean;
  /** One plain line when not. */
  why: string | null;
}

let cached: { at: number; value: SandboxSupport } | null = null;
const SUPPORT_TTL_MS = 10 * 60_000;

/** Whether this computer can run the process sandbox (srt). Looked at once per 10 minutes. */
export function sandboxSupport(now = Date.now()): SandboxSupport {
  if (cached && now - cached.at < SUPPORT_TTL_MS) return cached.value;
  const value = probeSupport(process.platform);
  cached = { at: now, value };
  return value;
}

/** For tests. */
export function resetSandboxSupport(): void {
  cached = null;
}

function onPath(cmd: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    try {
      if (dir && statSync(join(dir, cmd)).isFile()) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

function probeSupport(platform: NodeJS.Platform): SandboxSupport {
  if (platform === 'darwin') {
    return existsSync('/usr/bin/sandbox-exec') ? { ok: true, why: null } : { ok: false, why: 'This Mac has no sandbox-exec, so commands are off.' };
  }
  if (platform === 'linux') {
    const missing = ['bwrap', 'socat'].filter((c) => !onPath(c));
    if (missing.length > 0) {
      return { ok: false, why: `Commands are off: install ${missing.map((m) => (m === 'bwrap' ? 'bubblewrap' : m)).join(' and ')} to turn them on.` };
    }
    try {
      execFileSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', 'true'], { stdio: 'ignore', timeout: 5_000 });
    } catch {
      return { ok: false, why: 'Commands are off: this system blocks the user namespaces the sandbox needs (on Ubuntu 24.04, see the AppArmor note in the docs).' };
    }
    return { ok: true, why: null };
  }
  return { ok: false, why: 'Commands are off on this system for now; answers come from reading the code.' };
}
