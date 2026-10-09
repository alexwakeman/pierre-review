// "Resolve with Claude" — the route's refusals. A real Fastify, the real session store and the real
// run module; the PR lookup, the git probe and the session BUILD are stubbed (no clone, no model).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.DATABASE_URL = '/tmp/pierre-ai-resolve-routes-test.sqlite';
process.env.DEPLOYMENT_MODE = 'local';
process.env.DISABLE_SCHEDULER = 'true';

type PrCtx = { state: string; viewerPermission: string | null } | null;
// Account 1 owns PR 7. Any other (account, PR) pair is "not found" — the 404 that keeps the route
// from being an existence oracle.
const prs = new Map<string, PrCtx>();
vi.mock('../../db/queries.js', () => ({
  WRITE_PERMISSIONS: new Set(['WRITE', 'MAINTAIN', 'ADMIN']),
  getPrWriteContext: vi.fn(async (prId: number, accountId: number) => prs.get(`${accountId}:${prId}`) ?? null),
}));
vi.mock('../../conflict/git.js', () => ({ gitSupportsMergeTree: vi.fn(async () => true) }));

import type { ConflictModel } from '../../conflict/model-types.js';
import { claimSession, settleReady, __testing as sessions } from '../../conflict/session.js';
import { __testing as runs } from './run.js';
import { registerAiResolveRoutes } from './routes.js';
import type { AgentContext } from '../../review/agent-context.js';

let caller = 1;

function emptyModel(): ConflictModel {
  return {
    accountId: 1,
    prId: 7,
    owner: 'acme',
    name: 'web',
    number: 7,
    headSha: 'h',
    baseSha: 'b',
    headRef: 'feature',
    baseRef: 'main',
    mergeBaseSha: null,
    mergeBaseIsVirtual: false,
    mergedTreeSha: 't',
    files: [],
    totalConflictedPaths: 0,
    truncated: false,
    renameDetection: 'on',
    commitsAboveBase: 1,
    strategies: ['merge'],
    rebaseUnavailableReason: null,
    reservedBranchNames: ['main'],
    prBranchPushable: true,
    prBranchUnavailableReason: null,
  };
}

// The build behind a fresh claim: this PR turns out NOT to conflict any more.
const runOpen = vi.fn(async (rec: Parameters<typeof settleReady>[0]) => {
  settleReady(rec, emptyModel(), 'hash', true);
});

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  const ctx = {
    accountIdOf: () => caller,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    recordAiUsage: vi.fn(async () => {}),
  } as unknown as AgentContext;
  registerAiResolveRoutes(app, ctx, { runOpen: runOpen as never });
  await app.ready();
  return app;
}

beforeEach(() => {
  sessions.reset();
  runs.reset();
  caller = 1;
  prs.clear();
  prs.set('1:7', { state: 'open', viewerPermission: 'WRITE' });
  runOpen.mockClear();
});

describe('POST /api/prs/:id/conflicts/ai-resolve', () => {
  it('404s another account’s pull request, on every verb', async () => {
    const app = await build();
    caller = 2;
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/prs/7/conflicts/ai-resolve', payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode).toBe(404);
    }
    expect(runOpen).not.toHaveBeenCalled();
  });

  it('403s a reader without push access', async () => {
    prs.set('1:7', { state: 'open', viewerPermission: 'READ' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/prs/7/conflicts/ai-resolve', payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a closed pull request', async () => {
    prs.set('1:7', { state: 'merged', viewerPermission: 'WRITE' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/prs/7/conflicts/ai-resolve', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('NotOpen');
  });

  it('refuses a model that is not offered', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/prs/7/conflicts/ai-resolve', payload: { model: 'claude-old' } });
    expect(res.statusCode).toBe(400);
  });

  it('refuses at once when a WATCHED live session already says there are no conflicts', async () => {
    const claim = claimSession(1, 7, { restart: false, autoApply: false });
    if (claim.kind !== 'created') throw new Error('expected a fresh session');
    settleReady(claim.session, emptyModel(), 'hash', true);
    claim.session.subscribers.add(() => {});
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/prs/7/conflicts/ai-resolve', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'NoConflicts', message: 'This pull request no longer conflicts with main.' });
    expect(runOpen).not.toHaveBeenCalled();
  });

  it('⚠ rebuilds an UNWATCHED clean session rather than believing it (the base may have moved)', async () => {
    const claim = claimSession(1, 7, { restart: false, autoApply: false });
    if (claim.kind !== 'created') throw new Error('expected a fresh session');
    settleReady(claim.session, emptyModel(), 'hash', true);
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/prs/7/conflicts/ai-resolve', payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().resolution.sessionId).not.toBe(claim.session.sessionId);
    expect(runOpen).toHaveBeenCalled();
  });

  it('starts a run, and a build that finds no conflicts fails it with that sentence', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/prs/7/conflicts/ai-resolve', payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().resolution.status).toBe('preparing');
    await vi.waitFor(async () => {
      const got = await app.inject({ method: 'GET', url: '/api/prs/7/conflicts/ai-resolve' });
      expect(got.json().resolution).toMatchObject({
        status: 'failed',
        error: 'This pull request no longer conflicts with main.',
        choices: [],
      });
    });
    // The account's slot is released.
    expect(runs.runningAccounts.size).toBe(0);
  });

  it('answers null when there is nothing for this PR', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/prs/7/conflicts/ai-resolve' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolution: null });
  });
});
