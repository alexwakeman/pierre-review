// A SHORT-LIVED `codex app-server` JSON-RPC CLIENT (docs/CODEX-SPIKE.md § 6), and the cached account
// state Limn reads through it.
//
// `codex app-server` speaks newline-delimited JSON-RPC 2.0 on stdio: `initialize` {clientInfo}, the
// `initialized` notification, then requests. Limn asks three things, in ONE process per probe:
//   • `account/read` {refreshToken: true} — the sign-in check. ⚠ NOT `codex login status`, which
//     exits 0 for a sign-in that can no longer be refreshed; `account: null` is the real answer.
//   • `account/rateLimits/read` — the 5-hour (300 min) and weekly (10080 min) windows, `usedPercent`
//     as a WHOLE number, `resetsAt` in Unix seconds, `planType`.
//   • `account/usage/read` — the account's lifetime and daily token counts (the denominator of the
//     token-weighted budget share, docs/CODEX-PLAN.md § 6).
// Every process runs with CODEX_HOME = Limn's own home (ai/codex/home.ts) and no API-key variable.
//
// THE CACHE (the Claude usage probe's rules, ai/budget.ts): at most one probe every
// CODEX_PROBE_MIN_INTERVAL_MS, single-flight, in the BACKGROUND — a request reads the cached state
// (`codexStateCached`) and kicks a refresh (`kickCodexProbe`); it never waits on a process. A failed
// probe keeps the last state. The async readers (`codexAccount`, `codexRateLimits`) wait for a probe
// only when nothing has ever been read — the CLI and `detect()` use them, never a request path.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { AiUsageReading } from '@pierre-review/shared';
import { codexBinaryPath } from '../runtime.js';
import { codexHome, codexProcessEnv } from './home.js';
import {
  accountTokensInWindow,
  parseCodexAccount,
  parseCodexTokenUsage,
  readingFromCodexRateLimits,
  type CodexAccountInfo,
  type CodexDailyTokens,
  type LifetimeSample,
} from './readings.js';

/** One request's timeout. `account/read` with a token refresh is a network round trip. */
export const APP_SERVER_REQUEST_TIMEOUT_MS = 15_000;
/** A probe's whole budget (spawn + initialize + three reads). */
export const APP_SERVER_PROBE_TIMEOUT_MS = 30_000;
/** The probe runs at most this often. */
export const CODEX_PROBE_MIN_INTERVAL_MS = 5 * 60 * 1000;

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'AppServerError';
  }
}

export interface AppServerSpawnOptions {
  binary: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Extra arguments after `app-server`. */
  args?: string[];
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** One `codex app-server` process. Always `close()` it (or use `withCodexAppServer`). */
export class CodexAppServer {
  private buf = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private stderrTail = '';
  private closed = false;
  readonly exited: Promise<number | null>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onData(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    // A write after the process died must not crash the server.
    child.stdin.on('error', () => {});
    this.exited = new Promise((resolve) => {
      child.on('error', (err) => {
        this.failAll(new AppServerError(`codex app-server could not start: ${err.message}`));
        resolve(null);
      });
      child.on('close', (code) => {
        this.closed = true;
        this.failAll(new AppServerError(`codex app-server exited (code ${code ?? 'signal'})${this.stderrHint()}`));
        resolve(code);
      });
    });
  }

  /** Spawn, `initialize`, `initialized`. Rejects (and kills the process) on any failure. */
  static async start(opts: AppServerSpawnOptions): Promise<CodexAppServer> {
    const child = spawn(opts.binary, ['app-server', ...(opts.args ?? [])], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const server = new CodexAppServer(child, opts.requestTimeoutMs ?? APP_SERVER_REQUEST_TIMEOUT_MS);
    try {
      await server.request('initialize', {
        clientInfo: { name: opts.clientName ?? 'limn', version: opts.clientVersion ?? '0.0.0' },
      });
      server.notify('initialized');
      return server;
    } catch (err) {
      server.close();
      throw err;
    }
  }

  private stderrHint(): string {
    const last = this.stderrTail.trim().split('\n').at(-1)?.trim();
    return last ? `: ${last.slice(0, 300)}` : '';
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a protocol line
      }
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
      if (typeof m.id === 'number' && this.pending.has(m.id) && m.method === undefined) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error !== undefined) {
          const e = m.error as { message?: unknown; code?: unknown };
          p.reject(
            new AppServerError(
              typeof e?.message === 'string' ? e.message : 'codex app-server answered an error',
              typeof e?.code === 'number' ? e.code : null,
            ),
          );
        } else p.resolve(m.result);
      } else if (typeof m.method === 'string' && m.id === undefined) {
        for (const fn of this.listeners.get(m.method) ?? []) {
          try {
            fn(m.params);
          } catch {
            /* a listener's failure is its own */
          }
        }
      }
      // A server→client REQUEST (an approval prompt) is never expected from the methods Limn calls;
      // it is left unanswered and the caller's own timeout ends it.
    }
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** Send one request; resolves its `result`, rejects with its `error` or on the timeout. */
  request<T = unknown>(method: string, params: unknown = null, timeoutMs: number = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new AppServerError('codex app-server is closed'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`codex app-server did not answer ${method} in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  }

  /** Listen for a server notification (`account/login/completed`, …). Returns the unsubscribe. */
  on(method: string, fn: (params: unknown) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Stop the process (SIGTERM; it exits in ~20 ms, docs/CODEX-SPIKE.md § 9). Idempotent. */
  close(): void {
    this.failAll(new AppServerError('codex app-server was closed'));
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* gone */
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
}

/** The spawn options for Limn's own Codex home, or null when Codex is not installed. */
export function limnAppServerOptions(env: NodeJS.ProcessEnv = process.env): AppServerSpawnOptions | null {
  const binary = codexBinaryPath();
  if (!binary) return null;
  const home = codexHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // `--strict-config`: an unknown key in Limn's config.toml stops the process with a named error
  // instead of being ignored (measured: `app-server` honours it; `login`/`debug`/`features` refuse
  // the flag, so the CLI's sign-in runs without it).
  return { binary, env: codexProcessEnv(env), cwd: home, args: ['--strict-config'] };
}

/** Run `fn` against a fresh app-server and close it, within `timeoutMs` overall. */
export async function withCodexAppServer<T>(
  fn: (server: CodexAppServer) => Promise<T>,
  opts: AppServerSpawnOptions,
  timeoutMs: number = APP_SERVER_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let done = false;
  // ⚠ Close the process even when the timeout wins while it is still starting: the start resolves
  // later, sees `done`, and closes what it started.
  const started = CodexAppServer.start(opts).then((s) => {
    if (done) s.close();
    return s;
  });
  try {
    return await Promise.race([
      started.then((s) => fn(s)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppServerError('codex app-server timed out')), timeoutMs);
      }),
    ]);
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    started.then((s) => s.close()).catch(() => {});
  }
}

// ---- the probe and its cache ----------------------------------------------------------------------

/** One probe's answers. Each part is null when it was not read (or not understood). */
export interface CodexProbeResult {
  atMs: number;
  account: CodexAccountInfo | null;
  reading: AiUsageReading | null;
  lifetimeTokens: number | null;
  daily: CodexDailyTokens[] | null;
}

/** Read the account, the rate limits and the token usage in ONE app-server process. */
export async function probeCodexAccount(
  opts: AppServerSpawnOptions,
  nowMs: () => number = Date.now,
  // `false` only where a refresh must not happen (a sign-in Limn does not own). Limn's own home
  // refreshes its own token.
  { refreshToken = true }: { refreshToken?: boolean } = {},
): Promise<CodexProbeResult> {
  return withCodexAppServer(async (s) => {
    const account = parseCodexAccount(await s.request('account/read', { refreshToken }));
    // Windows and token counts exist only for a ChatGPT sign-in; an API key has neither.
    if (!account?.signedIn || account.type !== 'chatgpt') {
      return { atMs: nowMs(), account, reading: null, lifetimeTokens: null, daily: null };
    }
    const [limits, usage] = await Promise.all([
      s.request('account/rateLimits/read', null).catch(() => null),
      s.request('account/usage/read', null).catch(() => null),
    ]);
    const at = nowMs();
    const tokens = parseCodexTokenUsage(usage);
    return {
      atMs: at,
      account,
      reading: readingFromCodexRateLimits(limits, at),
      lifetimeTokens: tokens?.lifetimeTokens ?? null,
      daily: tokens?.daily ?? null,
    };
  }, opts);
}

interface CodexCache {
  /** The newest SUCCESSFUL probe. */
  last: CodexProbeResult | null;
  lastAttemptMs: number;
  lastError: string | null;
  inFlight: Promise<void> | null;
  /** Lifetime token samples, oldest first, the last 8 days. */
  samples: LifetimeSample[];
}

const SAMPLE_KEEP_MS = 8 * 24 * 60 * 60 * 1000;
const SAMPLE_MAX = 4000;

const cache: CodexCache = { last: null, lastAttemptMs: 0, lastError: null, inFlight: null, samples: [] };

export type CodexProber = () => Promise<CodexProbeResult>;
let proberOverride: CodexProber | null = null;

/** Test hook: replace the probe (and clear the cache, unless `keepState`). `null` = the real probe. */
export function _setCodexProbeForTest(p: CodexProber | null, opts: { keepState?: boolean } = {}): void {
  proberOverride = p;
  if (opts.keepState) return;
  cache.last = null;
  cache.lastAttemptMs = 0;
  cache.lastError = null;
  cache.inFlight = null;
  cache.samples = [];
}

function noteProbe(r: CodexProbeResult): void {
  // A probe that could not read the account at all is a failure: keep the last state.
  if (r.account == null) {
    cache.lastError = 'codex app-server did not report the account';
    return;
  }
  cache.last = r;
  cache.lastError = null;
  if (r.lifetimeTokens != null) {
    cache.samples.push({ atMs: r.atMs, lifetimeTokens: r.lifetimeTokens });
    cache.samples = cache.samples.filter((s) => s.atMs >= r.atMs - SAMPLE_KEEP_MS).slice(-SAMPLE_MAX);
  }
  if (!r.account.signedIn) cache.samples = [];
}

/**
 * Start a probe IN THE BACKGROUND when the cached state is older than the interval (or `force`).
 * Single-flight. Never throws; never starts when Codex is not installed. Returns the in-flight
 * promise (tests await it) or null when nothing started.
 */
export function kickCodexProbe(opts: { nowMs?: number; force?: boolean } = {}): Promise<void> | null {
  const nowMs = opts.nowMs ?? Date.now();
  if (cache.inFlight) return cache.inFlight;
  if (!opts.force && nowMs - cache.lastAttemptMs < CODEX_PROBE_MIN_INTERVAL_MS) return null;
  let prober = proberOverride;
  if (!prober) {
    const spawnOpts = limnAppServerOptions();
    if (!spawnOpts) return null;
    prober = () => probeCodexAccount(spawnOpts);
  }
  cache.lastAttemptMs = nowMs;
  const run = prober;
  cache.inFlight = (async () => {
    try {
      noteProbe(await run());
    } catch (err) {
      cache.lastError = (err as Error).message;
    } finally {
      cache.inFlight = null;
    }
  })();
  return cache.inFlight;
}

/** Forget the account (after a sign-in or sign-out) and probe again now. */
export function invalidateCodexState(): Promise<void> | null {
  cache.last = null;
  cache.samples = [];
  cache.lastAttemptMs = 0;
  return kickCodexProbe({ force: true });
}

/** The cached state, without starting anything. Cheap and sync. */
export function codexStateCached(): { last: CodexProbeResult | null; lastError: string | null } {
  return { last: cache.last, lastError: cache.lastError };
}

/** Wait for a state when none was ever read (the CLI, `detect()`); otherwise kick and answer the cache. */
async function freshEnough(): Promise<CodexProbeResult | null> {
  const p = kickCodexProbe();
  if (cache.last == null && p) await p;
  return cache.last;
}

/** Signed in to Codex (in Limn's own home)? And the ChatGPT plan. */
export async function codexAccount(): Promise<{ signedIn: boolean; plan: string | null }> {
  const last = await freshEnough();
  return { signedIn: !!last?.account?.signedIn, plan: last?.account?.plan ?? null };
}

/** The account's 5-hour and weekly windows as ONE normalised reading, or null when not read. */
export async function codexRateLimits(): Promise<AiUsageReading | null> {
  return (await freshEnough())?.reading ?? null;
}

/** The cached reading only (the budget's request path). Kicks a background refresh. */
export function codexRateLimitsCached(): AiUsageReading | null {
  kickCodexProbe();
  return cache.last?.reading ?? null;
}

/**
 * The account's tokens in `[fromMs, toMs]` — from the CACHE only (it never waits on a process; the
 * probe that fills it runs in the background). Null when not known. See `accountTokensInWindow`.
 */
export async function codexAccountTokens(window: { fromMs: number; toMs: number }): Promise<number | null> {
  return accountTokensInWindow(cache.samples, cache.last?.daily ?? null, window.fromMs, window.toMs);
}

/**
 * Does Limn's Codex home hold a ChatGPT sign-in, by the CACHED `account/read`? Cheap and sync; null
 * when nothing has been read yet (the caller decides what unknown means).
 */
export function codexSignedInCached(): { signedIn: boolean; type: string | null; plan: string | null } | null {
  const a = cache.last?.account;
  return a ? { signedIn: a.signedIn, type: a.type, plan: a.plan } : null;
}
