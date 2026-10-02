// The AI Fix routes: which model a fix run starts on, and that a push goes out as-is.
//
//   pnpm --filter @pierre-review/backend test ai-fix-routes
//
// ⚠ THE AGENTIC SWITCH MUST BE ON (it is, locally, unless LIMN_AI_DISABLED is set). `AIFIX_ENABLED`
// is `config.aiEnabled`, read at IMPORT time. Off, every POST answers
// 404 AiFixDisabled, the 400 case below passes for the wrong reason and the 202 cases fail.
//
// ⚠ A REAL Fastify with its DEFAULT ajv (so `removeAdditional` is in the path). The start route
// validates `model` in the HANDLER, not with a body schema, precisely so ajv cannot silently strip
// `seed` / `reviewText` / `commentTargets` — "the seed fields still reach startFix" is the
// assertion that would catch a schema added later without every key declared. The manager, the
// persistence layer and the PR lookups are mocked: no queue, no DB, no model, no git.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CLAUDE_REVIEW_MODELS, DEFAULT_AI_FIX_MODEL } from '@pierre-review/shared';
import type { AgentContext as ProContext } from '../../review/agent-context.js';


const startFix = vi.fn(async (..._args: unknown[]) => ({ status: 'queued' as const, fixId: 55 }));

vi.mock('./manager.js', () => ({
  startFix: (...args: unknown[]) => startFix(...args),
  getFixStatus: vi.fn(),
  requestFixCancel: vi.fn(() => false),
  subscribeFixStream: vi.fn(() => () => {}),
}));

const SUCCEEDED_FIX = {
  id: 9,
  accountId: 1,
  prId: 7,
  status: 'succeeded',
  patch: 'diff --git a/a.ts b/a.ts\n',
  baseSha: 'base123',
  commitMessage: 'fix: the thing',
  summary: 'Fixed the thing.',
  model: 'claude-opus-5-5',
};
const markFixPushed = vi.fn(async () => {});

vi.mock('./persist.js', () => ({
  getFixById: vi.fn(async () => SUCCEEDED_FIX),
  getLatestFix: vi.fn(async () => null),
  listFixHistory: vi.fn(async () => []),
  markFixPushed: (...args: unknown[]) => (markFixPushed as (...a: unknown[]) => unknown)(...args),
  parseCommentTargets: vi.fn(() => null),
  parseCommentVerdicts: vi.fn(() => null),
  parseFilesChanged: vi.fn(() => []),
}));

vi.mock('./pr-context.js', () => ({
  getFixPrContext: vi.fn(async () => ({
    prId: 7,
    repoId: 3,
    owner: 'acme',
    name: 'app',
    number: 12,
    baseRefName: 'main',
    defaultBranch: 'main',
  })),
  getViewerCanPush: vi.fn(async () => true),
}));

const applyAndPush = vi.fn(async (args: { target: { kind: string } }) => ({
  pushedBranch: args.target.kind === 'existing' ? 'feature' : 'feature-ai-fix',
  commitSha: 'c0ffee',
  ...(args.target.kind === 'new' ? { prNumber: 13, prUrl: 'https://github.com/acme/app/pull/13' } : {}),
}));

async function build(): Promise<FastifyInstance> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ctx = {
    accountIdOf: () => 1,
    log: { warn: vi.fn(), info: vi.fn() },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    github: {
      fetchPrHeadInfo: vi.fn(async () => ({
        headSha: 'base123',
        headRef: 'feature',
        headRepoFullName: 'acme/app',
        isFork: false,
        maintainerCanModify: false,
        baseRef: 'main',
      })),
    },
    coding: { applyAndPush },
  } as any as ProContext;
  const { default: Fastify } = await import('fastify');
  const { registerAiFixRoutes } = await import('./routes.js');
  const app = Fastify({ logger: false });
  registerAiFixRoutes(app, ctx);
  await app.ready();
  return app;
}

const start = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/pro/prs/7/ai-fix', payload: payload as object });
const push = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/pro/ai-fixes/9/push', payload: payload as object });

const startArg = (): Record<string, unknown> =>
  (startFix.mock.calls[0] as unknown[])[1] as Record<string, unknown>;

beforeEach(() => {
  startFix.mockClear();
  applyAndPush.mockClear();
  markFixPushed.mockClear();
});

describe('POST /api/pro/prs/:id/ai-fix — the model', () => {
  it('the default is Opus 5.5, and it is on the offered list', () => {
    expect(DEFAULT_AI_FIX_MODEL).toBe('claude-opus-5-5');
    expect(CLAUDE_REVIEW_MODELS).toContain(DEFAULT_AI_FIX_MODEL);
  });

  it('no model ⇒ the default', async () => {
    const app = await build();
    const res = await start(app, { seed: 'plain' });
    expect(res.statusCode).toBe(202);
    expect(startFix).toHaveBeenCalledTimes(1);
    expect(startArg().model).toBe(DEFAULT_AI_FIX_MODEL);
    await app.close();
  });

  it('an explicit null model ⇒ the default', async () => {
    const app = await build();
    const res = await start(app, { model: null });
    expect(res.statusCode).toBe(202);
    expect(startArg().model).toBe(DEFAULT_AI_FIX_MODEL);
    await app.close();
  });

  it('an offered model ⇒ that model', async () => {
    const app = await build();
    const res = await start(app, { model: 'claude-sonnet-5' });
    expect(res.statusCode).toBe(202);
    expect(startArg().model).toBe('claude-sonnet-5');
    await app.close();
  });

  it("a retired id ('claude-opus-4-8', the old Opus) ⇒ 400 ModelNotOffered, no run", async () => {
    const app = await build();
    const res = await start(app, { model: 'claude-opus-4-8' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'ModelNotOffered',
      message: 'That model is no longer offered.',
    });
    expect(startFix).not.toHaveBeenCalled();
    await app.close();
  });

  it('a non-string model ⇒ 400, no run (the body has no schema, so anything can arrive)', async () => {
    const app = await build();
    for (const model of [5, { id: 'claude-opus-5-5' }, ['claude-opus-5-5'], true]) {
      const res = await start(app, { model });
      expect(res.statusCode).toBe(400);
    }
    expect(startFix).not.toHaveBeenCalled();
    await app.close();
  });

  it('the seed fields still reach startFix (nothing stripped them)', async () => {
    const app = await build();
    const review = await start(app, { seed: 'review', reviewText: 'Rename the helper.' });
    expect(review.statusCode).toBe(202);
    expect(startArg()).toMatchObject({
      seed: 'review',
      seedText: 'Rename the helper.',
      model: DEFAULT_AI_FIX_MODEL,
    });

    startFix.mockClear();
    const comments = await start(app, {
      model: 'claude-sonnet-5',
      seed: 'comments',
      reviewText: 'must not be forwarded for the comments seed',
      commentTargets: [
        { kind: 'review_comment', id: 101 },
        { kind: 'pr_comment', id: 202 },
      ],
    });
    expect(comments.statusCode).toBe(202);
    expect(startArg()).toMatchObject({
      seed: 'comments',
      model: 'claude-sonnet-5',
      commentTargets: [
        { kind: 'review_comment', id: 101 },
        { kind: 'pr_comment', id: 202 },
      ],
    });
    expect(startArg().seedText).toBeUndefined();
    await app.close();
  });
});

describe('POST /api/pro/ai-fixes/:fixId/push — as-is, no trunk step', () => {
  it('pushes to the PR branch with no strategy', async () => {
    const app = await build();
    const res = await push(app, { target: 'existing' });
    expect(res.statusCode).toBe(200);
    expect(applyAndPush).toHaveBeenCalledTimes(1);
    const arg = (applyAndPush.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      baseSha: 'base123',
      patch: SUCCEEDED_FIX.patch,
      commitMessage: 'fix: the thing',
      target: { kind: 'existing', headRef: 'feature' },
    });
    // The result carries only what happened: no strategy, no "resolved conflicts", no force.
    expect(res.json()).toEqual({ pushedBranch: 'feature', commitSha: 'c0ffee' });
    expect(markFixPushed).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("pushes to a new branch and opens a PR; the old bundle's strategy:'plain' is accepted", async () => {
    const app = await build();
    const res = await push(app, { target: 'new', branch: ' feature-ai-fix ', strategy: 'plain' });
    expect(res.statusCode).toBe(200);
    const arg = (applyAndPush.mock.calls[0] as unknown[])[0] as { target: Record<string, unknown> };
    expect(arg.target).toMatchObject({ kind: 'new', branch: 'feature-ai-fix', base: 'main' });
    expect(res.json()).toMatchObject({ pushedBranch: 'feature-ai-fix', prNumber: 13 });
    await app.close();
  });

  it("an old tab's merge / rebase button ⇒ 400 UnsupportedStrategy, nothing pushed", async () => {
    const app = await build();
    for (const strategy of ['merge', 'rebase']) {
      const res = await push(app, { target: 'existing', strategy, autoResolve: true });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'UnsupportedStrategy',
        message: 'Reload the page to push this fix.',
      });
    }
    expect(applyAndPush).not.toHaveBeenCalled();
    expect(markFixPushed).not.toHaveBeenCalled();
    await app.close();
  });

  it('a new branch with no name ⇒ 400 BranchRequired', async () => {
    const app = await build();
    const res = await push(app, { target: 'new', branch: '  ' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'BranchRequired' });
    expect(applyAndPush).not.toHaveBeenCalled();
    await app.close();
  });

  it('the trunk routes are gone', async () => {
    const app = await build();
    for (const url of [
      '/api/pro/ai-fixes/9/merge-preview',
      '/api/pro/ai-fixes/9/rebase',
      '/api/pro/ai-fixes/9/rebase/cancel',
      '/api/pro/ai-fixes/9/push/cancel',
    ]) {
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404);
    }
    for (const url of ['/api/pro/ai-fixes/9/rebase/stream', '/api/pro/ai-fixes/9/push/stream']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    await app.close();
  });
});
