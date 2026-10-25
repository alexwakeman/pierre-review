// THE APP-SERVER CLIENT, THE CACHED ACCOUNT STATE AND THE SIGN-IN (ai/codex/app-server.ts, login.ts),
// against a stand-in `codex` (fake-codex.test-support.ts) — offline, no real Codex, no quota:
//   1. JSON-RPC: initialize + initialized, results, errors, a per-request timeout, notifications;
//      the process is closed every time (no child left behind);
//   2. the probe reads account + rate limits + token usage in ONE process, with CODEX_HOME = Limn's
//      own home and NO API key in its environment;
//   3. the cache: single flight, at most every 5 minutes, a failure keeps the last state, signed-out
//      clears the samples;
//   4. the sign-in: browser and device flows report what to open, completion flips to done and
//      re-reads the account, a failure says so, cancel and sign-out work, one sign-in at a time.
//
//   pnpm --filter @pierre-review/backend test ai/codex/app-server
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setFakeCodex, writeFakeCodex } from './fake-codex.test-support.js';

let root: string;
let fake: string;
let logFile: string;
const saved = { ...process.env };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'limn-codex-app-server-'));
  fake = writeFakeCodex(root);
  logFile = join(root, 'calls.log');
  process.env.LIMN_DATA_DIR = join(root, 'data');
  process.env.LIMN_CODEX_PATH = fake;
  setFakeCodex(fake, { log: logFile });
  // An API key in the parent environment must NOT reach the probe or the sign-in.
  process.env.OPENAI_API_KEY = 'sk-must-not-leak';
});

afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

const AS = await import('./app-server.js');
const L = await import('./login.js');
const { codexHome } = await import('./home.js');

afterEach(() => {
  AS._setCodexProbeForTest(null);
  L._resetCodexLoginForTest();
  setFakeCodex(fake, { mode: 'signedin' });
  rmSync(logFile, { force: true });
});

const calls = (): Array<Record<string, unknown>> =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

const opts = () => {
  const o = AS.limnAppServerOptions();
  if (!o) throw new Error('fake codex not found');
  return o;
};

describe('the JSON-RPC client', () => {
  it('initializes, answers results and errors, and closes its process', async () => {
    setFakeCodex(fake, { mode: 'error' });
    const s = await AS.CodexAppServer.start(opts());
    const limits = await s.request('account/rateLimits/read', null);
    expect((limits as { rateLimits: { planType: string } }).rateLimits.planType).toBe('plus');
    await expect(s.request('account/read', { refreshToken: true })).rejects.toThrow('refresh failed');
    await expect(s.request('nope/nope', null)).rejects.toThrow(/unknown method/);
    s.close();
    await s.exited;
    expect(s.isClosed).toBe(true);
    const log = calls();
    expect(log.map((c) => c.method ?? c.notification).filter(Boolean)).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
      'account/read',
      'nope/nope',
    ]);
    await expect(s.request('account/read')).rejects.toThrow(/closed/);
  });

  it('times a request out instead of hanging', async () => {
    setFakeCodex(fake, { mode: 'hang' });
    const s = await AS.CodexAppServer.start(opts());
    await expect(s.request('account/read', { refreshToken: true }, 200)).rejects.toThrow(/did not answer account\/read/);
    s.close();
    await s.exited;
  });

  it('a program that is not there fails cleanly', async () => {
    await expect(AS.CodexAppServer.start({ ...opts(), binary: join(root, 'missing-codex') })).rejects.toThrow(/could not start/);
  });
});

describe('the probe', () => {
  it("reads the account, the windows and the token counts in ONE process, in Limn's home, with no API key", async () => {
    const r = await AS.probeCodexAccount(opts(), () => 5000);
    expect(r).toEqual({
      atMs: 5000,
      account: { signedIn: true, type: 'chatgpt', plan: 'plus' },
      reading: {
        fiveHour: { utilization: 1, resetsAtMs: 1792939601000, observedAtMs: 5000 },
        week: { utilization: 3, resetsAtMs: 1793526401000, observedAtMs: 5000 },
        subscriptionType: 'plus',
      },
      lifetimeTokens: 12345,
      daily: [{ startMs: Date.UTC(2026, 9, 25), tokens: 500 }],
    });
    const log = calls();
    const spawns = log.filter((c) => Array.isArray(c.argv));
    expect(spawns).toHaveLength(1);
    // The lockdown rides on the app-server's argv too (a second layer over Limn's config.toml).
    const { lockedConfig } = await import('./config.js');
    expect(spawns[0]).toMatchObject({ argv: ['app-server', '--strict-config', ...lockedConfig()], codexHome: codexHome(), apiKey: false });
    expect(spawns[0]!.argv).toContain('features.remote_plugin=false');
    expect(log.find((c) => c.method === 'account/read')?.params).toEqual({ refreshToken: true });
    // ⚠ Never the reader's own ~/.codex.
    expect(codexHome()).toBe(join(root, 'data', 'codex'));
  });

  it('signed out: no window and no token read', async () => {
    setFakeCodex(fake, { mode: 'signedout' });
    const r = await AS.probeCodexAccount(opts());
    expect(r.account).toEqual({ signedIn: false, type: null, plan: null });
    expect(r.reading).toBeNull();
    expect(calls().some((c) => c.method === 'account/rateLimits/read')).toBe(false);
  });
});

describe('the cache', () => {
  const result = (atMs: number, lifetimeTokens: number | null, signedIn = true) => ({
    atMs,
    account: signedIn ? { signedIn: true, type: 'chatgpt', plan: 'plus' } : { signedIn: false, type: null, plan: null },
    reading: null,
    lifetimeTokens,
    daily: null,
  });

  it('is single-flight and runs at most every 5 minutes', async () => {
    let n = 0;
    AS._setCodexProbeForTest(async () => {
      n++;
      return result(1000, 10);
    });
    const T = 10_000_000;
    const a = AS.kickCodexProbe({ nowMs: T });
    const b = AS.kickCodexProbe({ nowMs: T });
    expect(a).toBe(b);
    await a;
    expect(AS.kickCodexProbe({ nowMs: T + 60_000 })).toBeNull();
    await AS.kickCodexProbe({ nowMs: T + AS.CODEX_PROBE_MIN_INTERVAL_MS });
    expect(n).toBe(2);
    expect(AS.codexSignedInCached()).toEqual({ signedIn: true, type: 'chatgpt', plan: 'plus' });
  });

  it('a failed probe keeps the last state', async () => {
    AS._setCodexProbeForTest(async () => result(1000, 10));
    await AS.kickCodexProbe({ force: true });
    AS._setCodexProbeForTest(
      async () => {
        throw new Error('boom');
      },
      { keepState: true },
    );
    await AS.kickCodexProbe({ force: true });
    expect(AS.codexSignedInCached()?.signedIn).toBe(true);
    expect(AS.codexStateCached().lastError).toBe('boom');
    // An answer with no account at all is a failure too, not a sign-out.
    AS._setCodexProbeForTest(async () => ({ ...result(2000, 10), account: null }), { keepState: true });
    await AS.kickCodexProbe({ force: true });
    expect(AS.codexSignedInCached()?.signedIn).toBe(true);
  });

  it('accountTokens: exact from the lifetime samples the probes took', async () => {
    let life = 100;
    let at = 1000;
    AS._setCodexProbeForTest(async () => result(at, life));
    await AS.kickCodexProbe({ force: true });
    life = 175;
    at = 1000 + 3600_000;
    await AS.kickCodexProbe({ force: true });
    expect(await AS.codexAccountTokens({ fromMs: 1000, toMs: 1000 + 3600_000 })).toEqual({ tokens: 75, fromMs: 1000, inclusive: false, toMs: 1000 + 3600_000 });
    // No sample before this window opened: the two inside it give a shorter span, named.
    expect(await AS.codexAccountTokens({ fromMs: 500, toMs: 1000 + 3600_000 })).toEqual({ tokens: 75, fromMs: 1000, inclusive: false, toMs: 1000 + 3600_000 });
    expect(await AS.codexAccountTokens({ fromMs: 500, toMs: 2000 })).toBeNull();
  });

  it('a sign-out forgets the samples', async () => {
    AS._setCodexProbeForTest(async () => result(1000, 100));
    await AS.kickCodexProbe({ force: true });
    AS._setCodexProbeForTest(async () => result(2000, null, false));
    await AS.kickCodexProbe({ force: true });
    expect(AS.codexSignedInCached()?.signedIn).toBe(false);
    expect(await AS.codexAccountTokens({ fromMs: 1000, toMs: 3000 })).toBeNull();
  });

  it('codexAccount() waits for the first read; later calls answer the cache', async () => {
    let n = 0;
    AS._setCodexProbeForTest(async () => {
      n++;
      return result(Date.now(), 1);
    });
    expect(await AS.codexAccount()).toEqual({ signedIn: true, plan: 'plus' });
    expect(await AS.codexAccount()).toEqual({ signedIn: true, plan: 'plus' });
    expect(n).toBe(1);
  });
});

describe('the sign-in', () => {
  it('browser flow: answers the URL, then completion ⇒ done, and the account is read again', async () => {
    setFakeCodex(fake, { mode: 'login-ok' });
    const s = await L.startCodexLogin('browser');
    expect(s).toMatchObject({ state: 'waiting', method: 'browser', authUrl: 'https://auth.openai.com/oauth/authorize?x=1' });
    for (let i = 0; i < 50 && L.codexLoginState().state === 'waiting'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(L.codexLoginState()).toEqual({ state: 'done' });
    const log = calls();
    expect(log.find((c) => c.method === 'account/login/start')?.params).toEqual({ type: 'chatgpt' });
    // Every process ran in Limn's home, with no API key; the config was written first, file-store auth.
    for (const c of log.filter((x) => Array.isArray(x.argv))) expect(c).toMatchObject({ codexHome: codexHome(), apiKey: false });
    expect(readFileSync(join(codexHome(), 'config.toml'), 'utf8')).toContain('cli_auth_credentials_store = "file"');
  });

  it('device flow: answers the page and the code', async () => {
    setFakeCodex(fake, { mode: 'login-hang' });
    const s = await L.startCodexLogin('device');
    expect(s).toMatchObject({
      state: 'waiting',
      method: 'device',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      authUrl: null,
    });
    // A second press joins it.
    expect(await L.startCodexLogin('device')).toEqual(s);
    expect(await L.cancelCodexLogin()).toEqual({ state: 'idle' });
    expect(calls().find((c) => c.method === 'account/login/cancel')?.params).toEqual({ loginId: 'L2' });
  });

  it('a cancel DURING the start window wins: the start it cancelled never overwrites it, nor comes back as waiting', async () => {
    setFakeCodex(fake, { mode: 'login-slow' });
    const pending = L.startCodexLogin('browser');
    // Cancel while `account/login/start` is still unanswered (the fake answers after 400 ms).
    await new Promise((r) => setTimeout(r, 150));
    expect(await L.cancelCodexLogin()).toEqual({ state: 'idle' });
    expect(await pending).toEqual({ state: 'idle' });
    await new Promise((r) => setTimeout(r, 500));
    expect(L.codexLoginState()).toEqual({ state: 'idle' });
    // Cancelled before the process even started: the same.
    const early = L.startCodexLogin('browser');
    await L.cancelCodexLogin();
    expect(await early).toEqual({ state: 'idle' });
    expect(L.codexLoginState()).toEqual({ state: 'idle' });
  });

  it('a NEW sign-in after a cancel never joins the start that cancel overtook (it would answer "idle")', async () => {
    setFakeCodex(fake, { mode: 'login-slow' });
    const dead = L.startCodexLogin('browser');
    await new Promise((r) => setTimeout(r, 150));
    await L.cancelCodexLogin();
    // The overtaken start is still in flight (its answer comes at 400 ms): a fresh press starts anew.
    const fresh = L.startCodexLogin('browser');
    expect(fresh).not.toBe(dead);
    expect(await dead).toEqual({ state: 'idle' });
    expect(await fresh).toMatchObject({ state: 'waiting', authUrl: 'https://auth.openai.com/oauth/authorize?x=1' });
    // …and the overtaken start's own clean-up did not clear the fresh one's slot: a third press joins it.
    expect(await L.startCodexLogin('browser')).toMatchObject({ state: 'waiting' });
    expect(L.codexLoginState()).toMatchObject({ state: 'waiting' });
    await L.cancelCodexLogin();
  });

  it('a refused sign-in says so', async () => {
    setFakeCodex(fake, { mode: 'login-fail' });
    await L.startCodexLogin('browser');
    for (let i = 0; i < 50 && L.codexLoginState().state === 'waiting'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(L.codexLoginState()).toEqual({ state: 'failed', message: 'access denied' });
  });

  it('a sign-in the reader never finishes is stopped', async () => {
    setFakeCodex(fake, { mode: 'login-hang' });
    await L.startCodexLogin('browser', { timeoutMs: 100 });
    for (let i = 0; i < 50 && L.codexLoginState().state === 'waiting'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(L.codexLoginState()).toMatchObject({ state: 'failed', message: expect.stringMatching(/too long/) });
  });

  it('sign-out runs account/logout in Limn’s home', async () => {
    expect(await L.codexLogout()).toBeNull();
    expect(calls().some((c) => c.method === 'account/logout')).toBe(true);
  });

  it('Codex not installed ⇒ one sentence, nothing spawned', async () => {
    const was = process.env.LIMN_CODEX_PATH;
    delete process.env.LIMN_CODEX_PATH;
    process.env.LIMN_DATA_DIR = join(root, 'empty-data');
    try {
      expect(await L.startCodexLogin('browser')).toEqual({
        state: 'failed',
        message: 'Codex is not set up yet. Run: limn ai install codex',
      });
      expect(AS.kickCodexProbe({ force: true })).toBeNull();
    } finally {
      process.env.LIMN_CODEX_PATH = was;
      process.env.LIMN_DATA_DIR = join(root, 'data');
    }
  });
});
