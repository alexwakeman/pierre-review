// THE CODEX WIRE (api/routes/ai-codex.ts + `MeResponse.ai`), end to end against a stand-in `codex`
// (ai/codex/fake-codex.test-support.ts) on a throwaway SQLite file — no real Codex, no quota:
//   1. /api/me carries `ai.provider` ('claude' unless LIMN_AI_PROVIDER says codex) and each
//      provider's own facts; Codex's sign-in is read in the BACKGROUND (the first /api/me never waits
//      on a process) and reported once read — and, every agent kind ported (Phase 3 complete), Codex is
//      AVAILABLE once signed in; `auto` still picks Claude when both are signed in, Codex when only
//      Codex is;
//   2. the sign-in routes: start (browser / device), poll, cancel, sign out; a bad method is a 400;
//   3. "Set up AI" refuses an unknown provider before downloading anything.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeCodex, writeFakeCodex } from '../../ai/codex/fake-codex.test-support.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ai-codex-routes-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
const root = mkdtempSync(join(tmpdir(), 'limn-ai-codex-routes-'));
process.env.LIMN_DATA_DIR = join(root, 'data');
process.env.LIMN_CODEX_PATH = writeFakeCodex(root);
setFakeCodex(process.env.LIMN_CODEX_PATH, { mode: 'login-hang' });
delete process.env.OPENAI_API_KEY;
delete process.env.LIMN_AI_PROVIDER;
delete process.env.LIMN_AI_DISABLED;

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let closeDb: (() => Promise<void>) | undefined;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  const { getAccountById } = await import('../../auth/account.js');
  const { meRoutes } = await import('./me.js');
  const { aiCodexRoutes } = await import('./ai-codex.js');
  const { aiRuntimeRoutes } = await import('./ai-runtime.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req: any) => {
    req.account = await getAccountById(1);
  });
  await app.register(meRoutes);
  await app.register(aiCodexRoutes);
  await app.register(aiRuntimeRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  (await import('../../ai/codex/login.js'))._resetCodexLoginForTest();
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  rmSync(root, { recursive: true, force: true });
});

const waitFor = async (ok: () => Promise<boolean>): Promise<void> => {
  // Generous: under a full parallel suite, spawning the stand-in program takes seconds.
  for (let i = 0; i < 600; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

describe('/api/me — the AI provider on the wire', () => {
  it('Claude is the provider; Codex is installed, its sign-in read in the background, and available once signed in', async () => {
    const first = (await app.inject({ method: 'GET', url: '/api/me' })).json();
    expect(first.ai.provider).toBe('claude');
    expect(first.ai.providers.claude).toHaveProperty('route');
    expect(first.ai.providers.codex.runtime).toBe('ready');
    // The background probe answers; the next /api/me reports it.
    await waitFor(async () => (await app.inject({ method: 'GET', url: '/api/me' })).json().ai.providers.codex.signedIn);
    const later = (await app.inject({ method: 'GET', url: '/api/me' })).json();
    const { kinds, ...rest } = later.ai.providers.codex;
    expect(rest).toEqual({
      runtime: 'ready',
      runtimeMessage: null,
      auth: 'ok',
      route: 'login',
      signedIn: true,
      plan: 'plus',
      available: true,
      message: null,
    });
    // Codex's OWN per-kind answer while Claude is active: every kind is ported (`plan` last), so every
    // run kind is 'ok' once signed in.
    const P = await import('../../ai/provider.js');
    for (const k of P.ALL_RUN_KINDS) {
      expect(P.codexRunKindReady(k), k).toBe(true);
      expect(kinds[k], k).toEqual({ auth: 'ok', message: null });
    }
    expect(kinds.plan).toEqual({ auth: 'ok', message: null });
    expect(kinds.complete).toEqual({ auth: 'ok', message: null });
    expect(Object.keys(kinds).sort()).toEqual([...P.ALL_RUN_KINDS].sort());
  }, 60_000);

  it('LIMN_AI_PROVIDER=codex: the provider is codex and the top-level pre-flight answers ok (signed in)', async () => {
    process.env.LIMN_AI_PROVIDER = 'codex';
    try {
      const me = (await app.inject({ method: 'GET', url: '/api/me' })).json();
      expect(me.ai.provider).toBe('codex');
      expect(me.ai.auth).toBe('ok');
      expect(me.ai.authMessage ?? null).toBeNull();
      expect(me.ai.kinds.plan).toEqual({ auth: 'ok', message: null });
    } finally {
      delete process.env.LIMN_AI_PROVIDER;
    }
  });

  it('LIMN_AI_PROVIDER=auto: Claude when both are signed in, Codex when only Codex is', async () => {
    const saved = { ...process.env };
    const emptyHome = mkdtempSync(join(tmpdir(), 'limn-ai-codex-nohome-'));
    process.env.LIMN_AI_PROVIDER = 'auto';
    try {
      // Both: a Claude credential (an OAuth token) and the ChatGPT sign-in read above.
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
      expect((await app.inject({ method: 'GET', url: '/api/me' })).json().ai.provider).toBe('claude');
      // Codex alone: no Claude credential anywhere (an empty home, no token, no key, no config dir).
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CONFIG_DIR;
      process.env.HOME = emptyHome;
      expect((await app.inject({ method: 'GET', url: '/api/me' })).json().ai.provider).toBe('codex');
    } finally {
      for (const k of ['LIMN_AI_PROVIDER', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe('the Codex sign-in routes', () => {
  it('start (device), poll, cancel', async () => {
    const started = (await app.inject({ method: 'POST', url: '/api/ai/codex/login', payload: { method: 'device' } })).json();
    expect(started.login).toMatchObject({ state: 'waiting', method: 'device', userCode: 'ABCD-1234' });
    const polled = (await app.inject({ method: 'GET', url: '/api/ai/codex/login' })).json();
    expect(polled.login.state).toBe('waiting');
    const cancelled = (await app.inject({ method: 'POST', url: '/api/ai/codex/login/cancel' })).json();
    expect(cancelled.login).toEqual({ state: 'idle' });
  });

  it('a bad method is a 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/ai/codex/login', payload: { method: 'telepathy' } });
    expect(r.statusCode).toBe(400);
  });

  it('sign out', async () => {
    const r = (await app.inject({ method: 'POST', url: '/api/ai/codex/logout' })).json();
    expect(r).toEqual({ ok: true, message: null });
  });
});

describe('"Set up AI"', () => {
  it('refuses an unknown provider before anything is downloaded', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/ai/runtime/install', payload: { provider: 'gemini' } });
    expect(r.statusCode).toBe(400);
  });
});
