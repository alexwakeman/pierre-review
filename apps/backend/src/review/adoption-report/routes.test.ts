// THE AI ADOPTION REPORT ROUTES on a SCRATCH SQLite with a FAKE completion — never a real model call.
//
//   GET  /api/reports/ai-adoption           (api/routes/adoption-report.ts): DB only, `?workspace=`
//        absent / unparseable / unknown ⇒ Default (never a 404), the scope echoed.
//   POST /api/reports/ai-adoption/commentary (review/adoption-report/routes.ts): 404 with AI off, 400 on a
//        bad body, 503 with no credential, ONE completion per slide over the figure table only (no
//        name, login, repo or workspace name in the model input), a grounded text returned as its
//        TEMPLATE, a text with a digit refused (fallback), usage recorded on every completed call, a
//        failed call a 502, a missing runtime a 503, nothing to say ⇒ no call, a memo miss ⇒ the
//        template with no call (never a recompute), and the memo TTL renewed on every read.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AI_SIGNALS_VERSION, type AiAdoptionReport } from '@pierre-review/shared';

const DB_PATH = join(tmpdir(), 'pierre-adoption-report-routes-test.sqlite');
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let db: any;
let schema: any;
let ws = 0;
let routes: typeof import('./routes.js');
let config: { aiEnabled: boolean };
const recordAiUsage = vi.fn(async () => {});
const prompts: { system: string; prompt: string }[] = [];
let answer = '';
let auth: 'ok' | 'none' = 'ok';

const DAY = 86_400_000;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  config = (await import('../../config.js')).config as any;
  const q = await import('../../db/queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_adr', githubLogin: 'adr', isLocal: true }).execute();
  ws = await q.ensureDefaultWorkspace(1);
  await q.renameWorkspace(ws, 1, 'Secret Workspace Name');
  const repoId = (
    await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'secretorg', name: 'secretrepo', githubNodeId: 'R_adr', createdAt: new Date(Date.now() - 200 * DAY) })
      .returning()
      .execute()
  )[0].id;
  const person = (await db.insert(schema.users).values({ githubLogin: 'zoe-login', displayName: 'Zoe Personname', isBot: false }).returning().execute())[0].id;
  await q.resolveWorkspaceScope(1, ws);
  for (let i = 0; i < 8; i++) {
    const mergedAt = new Date(Date.now() - (i < 6 ? 3 : 20) * DAY);
    await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: `PR_adr_${i}`,
        accountId: 1,
        repoId,
        number: i + 1,
        title: `pr ${i}`,
        state: 'merged',
        isDraft: false,
        authorId: person,
        openedAt: new Date(mergedAt.getTime() - DAY),
        updatedAt: mergedAt,
        mergedAt,
        aiSignals: JSON.stringify(i % 2 === 0 ? [{ vendor: 'claude', source: 'pr_body' }] : []),
        aiSignalsVersion: AI_SIGNALS_VERSION,
        aiSignalsCheckedAt: new Date(),
      })
      .execute();
  }
  routes = await import('./routes.js');
  routes.setAdoptionCommentaryCompleteForTests(async (o) => {
    prompts.push({ system: o.system, prompt: o.prompt });
    if (answer === 'THROW') throw new Error('boom');
    if (answer === 'RUNTIME') {
      const { AiRuntimeMissingError } = await import('../../ai/runtime.js');
      throw new (AiRuntimeMissingError as any)('Set up AI first.');
    }
    return { text: answer, usage: { inputTokens: 1000, outputTokens: 80 } };
  });
  const { registerAccountContext, accountIdOf } = await import('../../api/plugins/auth.js');
  const { adoptionReportRoutes } = await import('../../api/routes/adoption-report.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(adoptionReportRoutes);
  routes.registerAdoptionReportRoutes(app, {
    accountIdOf,
    log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    llm: { detectAuth: () => ({ status: auth }) },
    recordAiUsage,
  } as any);
  await app.ready();
});

afterAll(async () => {
  routes?.setAdoptionCommentaryCompleteForTests(null);
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  prompts.length = 0;
  recordAiUsage.mockClear();
  answer = '';
  auth = 'ok';
  config.aiEnabled = true;
});

const getReport = async (qs = `?workspace=${ws}`): Promise<AiAdoptionReport> => {
  const res = await app.inject({ method: 'GET', url: `/api/reports/ai-adoption${qs}` });
  expect(res.statusCode).toBe(200);
  return res.json() as AiAdoptionReport;
};
const comment = (payload: unknown) => app.inject({ method: 'POST', url: '/api/reports/ai-adoption/commentary', payload: payload as any });

describe('GET /api/reports/ai-adoption', () => {
  it('answers for the workspace and echoes it', async () => {
    const r = await getReport();
    expect(r.workspaceId).toBe(ws);
    expect(r.workspaceName).toBe('Secret Workspace Name');
    expect(r.adoption.periods.at(-1)).toMatchObject({ mergedPrs: 6, aiPrs: 3 });
  });

  it('resolves an absent, unparseable or unknown workspace to Default (never a 404)', async () => {
    for (const qs of ['', '?workspace=abc', '?workspace=99999', '?workspace=-3']) expect((await getReport(qs)).workspaceId).toBe(ws);
  });

  it('is served with AI off too (spend withheld)', async () => {
    config.aiEnabled = false;
    const r = await getReport();
    expect(r.cost.aiEnabled).toBe(false);
    expect(r.cost.comparisons[0]!.after).toMatchObject({ available: false, reason: 'ai_off' });
  });
});

describe('POST /api/reports/ai-adoption/commentary', () => {
  it('404s with AI off', async () => {
    config.aiEnabled = false;
    const r = await getReport();
    expect((await comment({ workspaceId: ws, slide: 'adoption', generatedAt: r.generatedAt })).statusCode).toBe(404);
    expect(prompts).toHaveLength(0);
  });

  it('400s a bad body', async () => {
    for (const body of [{}, { workspaceId: ws, slide: 'title', generatedAt: 'x' }, { workspaceId: 'x', slide: 'adoption', generatedAt: 'x' }, { workspaceId: ws, slide: 'adoption' }, { workspaceId: 1.5, slide: 'adoption', generatedAt: 'x' }]) {
      expect((await comment(body)).statusCode).toBe(400);
    }
  });

  it('503s with no credential, and makes no call', async () => {
    auth = 'none';
    const r = await getReport();
    const res = await comment({ workspaceId: ws, slide: 'adoption', generatedAt: r.generatedAt });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'no_credential' });
    expect(prompts).toHaveLength(0);
  });

  it('returns a grounded text as its TEMPLATE and records the cost', async () => {
    const r = await getReport();
    // `ai_share.before` rests on two PRs (below the floor), so only the after figure may be named.
    answer = 'AI was involved in {{ai_share.after}} of merged PRs {{period.after}}.';
    const res = await comment({ workspaceId: ws, slide: 'adoption', generatedAt: r.generatedAt });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slide: 'adoption', source: 'ai', template: answer, provider: 'claude', model: 'claude-haiku-5-5' });
    expect((res.json() as any).costUsd).toBeGreaterThan(0);
    expect(prompts).toHaveLength(1);
    expect(recordAiUsage).toHaveBeenCalledTimes(1);
    expect(recordAiUsage.mock.calls[0]).toEqual([expect.objectContaining({ accountId: 1, seam: 'summary', feature: 'adoption_report' })]);
  });

  it('sends the figure table only: no person, login, repo or workspace name', async () => {
    const r = await getReport();
    answer = 'AI was involved in {{ai_share.after}} of merged PRs.';
    for (const slide of ['summary', 'adoption', 'people', 'delivery', 'guardrails']) {
      await comment({ workspaceId: ws, slide, generatedAt: r.generatedAt });
    }
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      const all = `${p.system}\n${p.prompt}`;
      for (const secret of ['Zoe', 'Personname', 'zoe-login', 'secretorg', 'secretrepo', 'Secret Workspace Name', 'Prepared for']) expect(all).not.toContain(secret);
      expect(p.prompt).toMatch(/---BEGIN FIGURES \S+---/);
    }
    expect(prompts.find((p) => p.prompt.startsWith('Slide: AI adoption'))?.prompt).toContain('{{ai_share.after}}');
  });

  it('refuses a text with a digit (fallback), still recording the call', async () => {
    const r = await getReport();
    answer = 'AI was involved in 50% of merged PRs, see {{ai_share.after}}.';
    const res = await comment({ workspaceId: ws, slide: 'adoption', generatedAt: r.generatedAt });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slide: 'adoption', source: 'fallback', reason: 'rejected' });
    expect(recordAiUsage).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown placeholder and a causal claim', async () => {
    const r = await getReport();
    for (const text of ['Lead time was {{lead_time.secret}}.', 'AI use rose to {{ai_share.after}} because of the new tools.']) {
      answer = text;
      expect((await comment({ workspaceId: ws, slide: 'adoption', generatedAt: r.generatedAt })).json()).toMatchObject({ source: 'fallback', reason: 'rejected' });
    }
  });

  it('a failed call is a 502; a missing runtime a 503', async () => {
    const r = await getReport();
    answer = 'THROW';
    expect((await comment({ workspaceId: ws, slide: 'adoption', generatedAt: r.generatedAt })).statusCode).toBe(502);
    answer = 'RUNTIME';
    const res = await comment({ workspaceId: ws, slide: 'adoption', generatedAt: r.generatedAt });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'runtime' });
    expect(recordAiUsage).not.toHaveBeenCalled();
  });

  it('answers a memo miss with the template and no call: it never recomputes or trusts the client', async () => {
    answer = 'AI was involved in {{ai_share.after}} of merged PRs.';
    const res = await comment({ workspaceId: ws, slide: 'adoption', generatedAt: '2001-01-01T00:00:00.000Z' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slide: 'adoption', source: 'fallback', reason: 'stale' });
    expect(prompts).toHaveLength(0);
    expect(recordAiUsage).not.toHaveBeenCalled();
  });

  it('keeps the figures through a download longer than the TTL (each read renews it), then goes stale', async () => {
    answer = 'AI was involved in {{ai_share.after}} of merged PRs.';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
      const r = await getReport();
      const slides = ['summary', 'adoption', 'people', 'delivery'];
      for (const slide of slides) {
        // 90s per slide: the whole download (6 min) outlasts the two-minute TTL many times over.
        vi.setSystemTime(Date.now() + 90_000);
        const res = await comment({ workspaceId: ws, slide, generatedAt: r.generatedAt });
        expect(res.statusCode, slide).toBe(200);
        expect((res.json() as any).reason, slide).not.toBe('stale');
      }
      expect(prompts.length).toBeGreaterThan(0);
      // Nobody reads it for longer than the TTL: gone, and the next slide uses the template.
      const calls = prompts.length;
      vi.setSystemTime(Date.now() + 3 * 60_000);
      const late = await comment({ workspaceId: ws, slide: 'guardrails', generatedAt: r.generatedAt });
      expect(late.json()).toEqual({ slide: 'guardrails', source: 'fallback', reason: 'stale' });
      expect(prompts).toHaveLength(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes no call when the slide has nothing to say', async () => {
    const empty = (await import('../../db/queries.js')).createWorkspace;
    const other = (await empty(1, 'Empty')).id;
    const r = await getReport(`?workspace=${other}`);
    expect(r.workspaceId).toBe(other);
    const res = await comment({ workspaceId: other, slide: 'courts', generatedAt: r.generatedAt });
    expect(res.json()).toEqual({ slide: 'courts', source: 'fallback', reason: 'nothing_to_say' });
    expect(prompts).toHaveLength(0);
  });
});
