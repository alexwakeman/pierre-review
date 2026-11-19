// PUT /api/ai/provider (Settings → AI) and what /api/me says after it, over a throwaway SQLite file —
// no model, no Codex process:
//   1. an unknown value is a 400; a good one is STORED (accounts.ai_provider), held in memory at once,
//      and /api/me reports it (`ai.providerSetting`, `ai.provider`) on the very next request;
//   2. the boot's load reads the stored value back into memory (a restart keeps the choice);
//   3. an explicitly set LIMN_AI_PROVIDER wins: /api/me says `source: 'env'` and the PUT is a 409;
//   4. the Effort level (PUT /api/ai/effort) follows the same three rules: stored + held + reported,
//      read back at boot, and REVIEW_EFFORT wins (409); null goes back to Default.
//   5. the run profiles (PUT /api/ai/run-profiles): validated, stored, held, reported and read back at
//      boot; the effort compat path drops every profile effort.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ai-provider-route-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
const root = mkdtempSync(join(tmpdir(), 'limn-ai-provider-route-'));
process.env.LIMN_DATA_DIR = join(root, 'data');
delete process.env.OPENAI_API_KEY;
delete process.env.LIMN_AI_PROVIDER;
delete process.env.LIMN_AI_DISABLED;
delete process.env.REVIEW_EFFORT;

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let closeDb: (() => Promise<void> | void) | undefined;
let setting: typeof import('../../ai/provider-setting.js');
let store: typeof import('../../ai/provider-store.js');
let effort: typeof import('../../ai/effort.js');

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  setting = await import('../../ai/provider-setting.js');
  store = await import('../../ai/provider-store.js');
  effort = await import('../../ai/effort.js');
  const { getAccountById } = await import('../../auth/account.js');
  const { meRoutes } = await import('./me.js');
  const { aiProviderRoutes } = await import('./ai-provider.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req: any) => {
    req.account = await getAccountById(1);
  });
  await app.register(meRoutes);
  await app.register(aiProviderRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  (await import('../../ai/run-profile.js')).setStoredAiRunProfiles(null);
  setting?.setStoredAiProviderSetting(null);
  effort?.setStoredAiEffort(null);
  delete process.env.REVIEW_EFFORT;
  delete process.env.LIMN_AI_PROVIDER;
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  rmSync(root, { recursive: true, force: true });
});

const me = async (): Promise<any> => (await app.inject({ method: 'GET', url: '/api/me' })).json().ai;
const put = (value: unknown) => app.inject({ method: 'PUT', url: '/api/ai/provider', payload: { value } });

describe('the provider choice', () => {
  it('starts at auto, chosen in Settings (Claude runs)', async () => {
    const ai = await me();
    expect(ai.providerSetting).toEqual({ value: 'auto', source: 'settings' });
    expect(ai.provider).toBe('claude');
  });

  it('refuses an unknown value', async () => {
    const res = await put('gemini');
    expect(res.statusCode).toBe(400);
    expect((await me()).providerSetting.value).toBe('auto');
  });

  it('stores a choice and /api/me reports it on the next request (no restart)', async () => {
    const res = await put('codex');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ setting: { value: 'codex', source: 'settings' }, provider: 'codex' });
    const ai = await me();
    expect(ai.providerSetting).toEqual({ value: 'codex', source: 'settings' });
    expect(ai.provider).toBe('codex');
    const { db, schema } = await import('../../db/client.js');
    const rows = await db.select({ v: schema.accounts.aiProvider }).from(schema.accounts).execute();
    expect(rows.some((r) => r.v === 'codex')).toBe(true);
  });

  it('a restart reads the stored choice back', async () => {
    setting.setStoredAiProviderSetting(null);
    expect(setting.aiProviderSetting()).toBe('auto');
    expect(await store.loadStoredAiProvider(1)).toBe('codex');
    expect(setting.aiProviderSetting()).toBe('codex');
  });

  it('LIMN_AI_PROVIDER wins: /api/me says so and the PUT is refused', async () => {
    process.env.LIMN_AI_PROVIDER = 'claude';
    try {
      const ai = await me();
      expect(ai.providerSetting).toEqual({ value: 'claude', source: 'env' });
      expect(ai.provider).toBe('claude');
      const res = await put('codex');
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe('LIMN_AI_PROVIDER is set, so it decides the provider.');
    } finally {
      delete process.env.LIMN_AI_PROVIDER;
    }
    // The new name wins the same way, and the refusal names the variable that is set.
    process.env.ENSEMBLE_AI_PROVIDER = 'claude';
    try {
      const res = await put('codex');
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe('ENSEMBLE_AI_PROVIDER is set, so it decides the provider.');
    } finally {
      delete process.env.ENSEMBLE_AI_PROVIDER;
    }
    // The stored choice is untouched by the refused write.
    expect((await me()).providerSetting).toEqual({ value: 'codex', source: 'settings' });
    await put('auto');
    expect((await me()).providerSetting).toEqual({ value: 'auto', source: 'settings' });
  });
});

const putEffort = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/ai/effort', payload: payload as object });

describe('the effort level', () => {
  it('starts at Default, chosen in Settings', async () => {
    expect((await me()).effortSetting).toEqual({ value: null, source: 'settings' });
  });

  it('refuses an unknown level, a Codex-only word and a missing value', async () => {
    for (const bad of [{ value: 'ultra' }, { value: 'minimal' }, { value: 3 }, {}]) {
      expect((await putEffort(bad)).statusCode).toBe(400);
    }
    expect((await me()).effortSetting.value).toBeNull();
  });

  it('stores a level, holds it for the next run and reports it; a restart reads it back', async () => {
    const res = await putEffort({ value: 'high' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ setting: { value: 'high', source: 'settings' } });
    expect((await me()).effortSetting).toEqual({ value: 'high', source: 'settings' });
    expect(effort.agenticRunEffort('claude', { role: 'deep' }, 'worktree')).toBe('high');
    effort.setStoredAiEffort(null);
    expect(await store.loadStoredAiEffort(1)).toBe('high');
    expect(effort.chosenAiEffort()).toBe('high');
  });

  it('REVIEW_EFFORT wins: /api/me says so and the PUT is refused', async () => {
    process.env.REVIEW_EFFORT = 'max';
    try {
      expect((await me()).effortSetting).toEqual({ value: 'max', source: 'env' });
      expect((await putEffort({ value: 'low' })).statusCode).toBe(409);
    } finally {
      delete process.env.REVIEW_EFFORT;
    }
    expect((await me()).effortSetting).toEqual({ value: 'high', source: 'settings' });
  });

  it('null goes back to Default', async () => {
    expect((await putEffort({ value: null })).statusCode).toBe(200);
    expect((await me()).effortSetting).toEqual({ value: null, source: 'settings' });
    const { db, schema } = await import('../../db/client.js');
    const rows = await db.select({ v: schema.accounts.aiEffort }).from(schema.accounts).execute();
    expect(rows.every((r) => r.v == null)).toBe(true);
  });
});

const putProfiles = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/ai/run-profiles', payload: payload as object });

describe('the run profiles', () => {
  it('start from today: both review vendors on at the usual models, the old level, rounds 5', async () => {
    const p = (await me()).runProfiles;
    expect(p.review.claude).toEqual({ enabled: true, model: 'claude-opus-5-5', effort: null });
    expect(p.review.codex).toEqual({ enabled: true, model: 'gpt-6.1-sol', effort: null });
    // AI Fix's own review rounds (its loop) default to 5 too.
    expect(p.fix).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: null, rounds: 5 });
    expect(p.build).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: null, rounds: 5 });
    expect(p.effortSource).toBe('settings');
  });

  it('refuses a bad body with one sentence: no profiles, an unknown field, a model of the other vendor, a bad effort or rounds, no review vendor on', async () => {
    for (const bad of [
      {},
      { profiles: { review: { gemini: {} } } },
      { profiles: { review: { claude: { model: 'gpt-6.1-sol' } } } },
      { profiles: { fix: { provider: 'codex', model: 'claude-opus-5-5' } } },
      { profiles: { fix: { model: 'claude-opus-5-5' } } },
      { profiles: { build: { effort: 'ultra' } } },
      { profiles: { build: { rounds: 7 } } },
      { profiles: { build: { rounds: 0 } } },
      { profiles: { fix: { rounds: 7 } } },
      { profiles: { review: { claude: { enabled: false }, codex: { enabled: false } } } },
    ]) {
      const res = await putProfiles(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(typeof res.json().message).toBe('string');
    }
  });

  it('stores the whole object, holds it for the next run, reports it and reads it back at boot', async () => {
    const profiles = {
      review: { claude: { enabled: true, model: 'claude-sonnet-5', effort: 'high' }, codex: { enabled: false, effort: 'low' } },
      fix: { provider: 'codex', model: 'gpt-6.1-terra', effort: 'xhigh', rounds: 2 },
      build: { provider: 'claude', model: 'claude-opus-5-5', effort: null, rounds: 3 },
    };
    const res = await putProfiles({ profiles });
    expect(res.statusCode).toBe(200);
    const p = res.json().runProfiles;
    expect(p.review.claude).toEqual({ enabled: true, model: 'claude-sonnet-5', effort: 'high' });
    expect(p.review.codex).toEqual({ enabled: false, model: 'gpt-6.1-sol', effort: 'low' });
    expect(p.fix).toEqual({ provider: 'codex', model: 'gpt-6.1-terra', effort: 'xhigh', rounds: 2 });
    expect(p.build).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: null, rounds: 3 });
    expect((await me()).runProfiles).toEqual(p);
    expect(effort.agenticRunEffort('claude', { role: 'deep' }, 'worktree')).toBe('high');
    expect(effort.agenticRunEffort('codex', { role: 'deep' }, 'worktree', process.env, 'fix')).toBe('xhigh');
    const rp = await import('../../ai/run-profile.js');
    rp.setStoredAiRunProfiles(null);
    expect(await store.loadStoredAiRunProfiles(1)).toEqual(profiles);
    expect(rp.buildLoopRounds()).toBe(3);
    expect(rp.fixLoopRounds()).toBe(2);
  });

  it('the effort compat path sets every surface: the one level, every profile effort dropped', async () => {
    expect((await putEffort({ value: 'medium' })).statusCode).toBe(200);
    const p = (await me()).runProfiles;
    expect([p.review.claude.effort, p.review.codex.effort, p.fix.effort, p.build.effort]).toEqual(['medium', 'medium', 'medium', 'medium']);
    // The rest of the profiles stay.
    expect(p.review.codex.enabled).toBe(false);
    expect(p.build.rounds).toBe(3);
  });

  it('REVIEW_EFFORT wins over every profile effort (the controls lock)', async () => {
    process.env.REVIEW_EFFORT = 'max';
    try {
      const p = (await me()).runProfiles;
      expect(p.effortSource).toBe('env');
      expect([p.review.claude.effort, p.fix.effort, p.build.effort]).toEqual(['max', 'max', 'max']);
    } finally {
      delete process.env.REVIEW_EFFORT;
    }
  });

  it('an empty object goes back to none (NULL)', async () => {
    expect((await putProfiles({ profiles: {} })).statusCode).toBe(200);
    const { db, schema } = await import('../../db/client.js');
    const rows = await db.select({ v: schema.accounts.aiRunProfiles }).from(schema.accounts).execute();
    expect(rows.every((r) => r.v == null)).toBe(true);
    expect((await import('../../ai/run-profile.js')).storedAiRunProfiles()).toBeNull();
    expect((await putEffort({ value: null })).statusCode).toBe(200);
  });
});
