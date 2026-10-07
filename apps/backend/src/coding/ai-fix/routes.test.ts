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
// `seed` / `instruction` / `sourceReviewId` — "the seed fields still reach startFix" is the
// assertion that would catch a schema added later without every key declared. The manager, the
// persistence layer and the PR lookups are mocked: no queue, no DB, no model, no git.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CLAUDE_REVIEW_MODELS, DEFAULT_AI_FIX_MODEL } from '@pierre-review/shared';
import type { AgentContext as ProContext } from '../../review/agent-context.js';


const startFix = vi.fn(async (..._args: unknown[]) => ({ status: 'queued' as const, fixId: 55 }));

const PREVIEW = {
  sourceReviewId: 4,
  items: [
    {
      key: 'finding:31',
      section: 'findings',
      label: 'Null deref',
      detail: null,
      path: 'a.ts',
      line: 1,
      severity: 'blocker',
      defaultIncluded: true,
      chars: 120,
    },
  ],
  budgetChars: 40_000,
  cutByBudget: [],
};
const loadFixPreview = vi.fn(async (..._args: unknown[]): Promise<typeof PREVIEW | null> => PREVIEW);

vi.mock('./manager.js', () => ({
  startFix: (...args: unknown[]) => startFix(...args),
  loadFixPreview: (...args: unknown[]) => loadFixPreview(...args),
  getFixStatus: vi.fn(),
  requestFixCancel: vi.fn(() => false),
  subscribeFixStream: vi.fn(() => () => {}),
}));

// The PR's newest SUCCEEDED review (the preview's default when no id is sent).
const getLatestSucceededReviewId = vi.fn(async (..._args: unknown[]): Promise<number | null> => 4);
vi.mock('../../review/claude-review/persist.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../review/claude-review/persist.js')>()),
  getLatestSucceededReviewId: (...args: unknown[]) => getLatestSucceededReviewId(...args),
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
  // A row from the REMOVED comments seed, with its legacy JSON still on it.
  seed: 'comments',
  commentTargets: '[{"ref":"C1"}]',
  commentVerdicts: 'not json',
  trigger: null,
  reviewItems: null,
  changeReport: null,
};
const markFixPushed = vi.fn(async () => {});

vi.mock('./persist.js', async (importOriginal) => {
  // The REAL parsers: "a row from a removed seed still reads" is a claim about them.
  const real = await importOriginal<typeof import('./persist.js')>();
  return {
    getFixById: vi.fn(async () => SUCCEEDED_FIX),
    getLatestFix: vi.fn(async () => null),
    listFixHistory: vi.fn(async () => []),
    markFixPushed: (...args: unknown[]) => (markFixPushed as (...a: unknown[]) => unknown)(...args),
    parseReviewItems: real.parseReviewItems,
    parseChangeReport: real.parseChangeReport,
    parseTrigger: real.parseTrigger,
    parseFilesChanged: real.parseFilesChanged,
  };
});

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
    const res = await start(app, { seed: 'plain', instruction: 'Fix the typo.' });
    expect(res.statusCode).toBe(202);
    expect(startFix).toHaveBeenCalledTimes(1);
    expect(startArg().model).toBe(DEFAULT_AI_FIX_MODEL);
    await app.close();
  });

  it('an explicit null model ⇒ the default', async () => {
    const app = await build();
    const res = await start(app, { model: null, instruction: 'Fix the typo.' });
    expect(res.statusCode).toBe(202);
    expect(startArg().model).toBe(DEFAULT_AI_FIX_MODEL);
    await app.close();
  });

  it('an offered model ⇒ that model', async () => {
    const app = await build();
    const res = await start(app, { model: 'claude-sonnet-5', instruction: 'Fix the typo.' });
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
    const review = await start(app, { seed: 'review', sourceReviewId: 41, reviewText: 'ignored' });
    expect(review.statusCode).toBe(202);
    expect(startArg()).toMatchObject({
      seed: 'review',
      sourceReviewId: 41,
      trigger: 'manual',
      model: DEFAULT_AI_FIX_MODEL,
    });
    // The review seed is built server-side from the stored run: no client text reaches it.
    expect(startArg().instruction).toBeUndefined();

    startFix.mockClear();
    const plain = await start(app, { model: 'claude-sonnet-5', instruction: '  Rename the helper. ' });
    expect(plain.statusCode).toBe(202);
    expect(startArg()).toMatchObject({
      seed: 'plain',
      model: 'claude-sonnet-5',
      instruction: 'Rename the helper.',
      sourceReviewId: null,
    });
    await app.close();
  });
});

describe('POST /api/pro/prs/:id/ai-fix — the two entry points', () => {
  it("the removed seeds ('comments', 'ci_analysis') ⇒ 400 SeedRemoved, no run", async () => {
    const app = await build();
    for (const seed of ['comments', 'ci_analysis']) {
      const res = await start(app, {
        seed,
        instruction: 'x',
        commentTargets: [{ kind: 'review_comment', id: 1 }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'SeedRemoved',
        message: 'That kind of fix is no longer offered. Reload the page.',
      });
    }
    expect(startFix).not.toHaveBeenCalled();
    await app.close();
  });

  it('an unknown seed ⇒ 400 UnknownSeed', async () => {
    const app = await build();
    for (const seed of ['everything', 5, null]) {
      const res = await start(app, { seed, instruction: 'x' });
      // null reads as "omitted" ⇒ plain, which is fine with an instruction.
      if (seed === null) expect(res.statusCode).toBe(202);
      else expect(res.json()).toMatchObject({ error: 'UnknownSeed' });
    }
    await app.close();
  });

  it('plain needs a non-blank instruction under the cap', async () => {
    const app = await build();
    for (const instruction of [undefined, '', '   ', 7]) {
      const res = await start(app, { seed: 'plain', instruction });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'InstructionRequired' });
    }
    const long = await start(app, { seed: 'plain', instruction: 'x'.repeat(4001) });
    expect(long.json()).toMatchObject({ error: 'InstructionTooLong' });
    expect(startFix).not.toHaveBeenCalled();
    await app.close();
  });

  it('review needs a positive integer review id', async () => {
    const app = await build();
    for (const sourceReviewId of [undefined, 0, -3, 1.5, '41']) {
      const res = await start(app, { seed: 'review', sourceReviewId });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'ReviewRequired' });
    }
    expect(startFix).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps the manager refusals', async () => {
    const app = await build();
    startFix.mockResolvedValueOnce({ status: 'review_unavailable' } as never);
    expect((await start(app, { seed: 'review', sourceReviewId: 41 })).json()).toMatchObject({
      error: 'ReviewUnavailable',
    });
    startFix.mockResolvedValueOnce({ status: 'nothing_to_fix' } as never);
    const r = await start(app, { seed: 'review', sourceReviewId: 41 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'NothingToFix' });
    await app.close();
  });
});

describe('GET /api/pro/ai-fixes/:fixId — rows from removed seeds still read', () => {
  it('a comments-seeded row answers 200 with the history fields, never 500', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/pro/ai-fixes/9' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 9,
      seed: 'comments',
      trigger: 'manual',
      reviewItems: null,
      changeReport: null,
    });
    expect(res.json()).not.toHaveProperty('commentVerdicts');
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

describe('the fix picker — preview and selection', () => {
  it('GET …/ai-fix/preview answers the manager’s preview for this PR’s review', async () => {
    const app = await build();
    loadFixPreview.mockClear();
    const res = await app.inject({ method: 'GET', url: '/api/pro/prs/7/ai-fix/preview?sourceReviewId=4' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(PREVIEW);
    expect(loadFixPreview.mock.calls[0]?.[1]).toEqual({ accountId: 1, prId: 7, reviewId: 4 });
    await app.close();
  });

  it('no review id ⇒ the latest SUCCEEDED review (a failed newer run does not hide it)', async () => {
    const app = await build();
    loadFixPreview.mockClear();
    getLatestSucceededReviewId.mockClear();
    getLatestSucceededReviewId.mockResolvedValueOnce(4);
    const res = await app.inject({ method: 'GET', url: '/api/pro/prs/7/ai-fix/preview' });
    expect(res.statusCode).toBe(200);
    expect(getLatestSucceededReviewId.mock.calls[0]?.slice(1)).toEqual([7, 1]);
    expect(loadFixPreview.mock.calls[0]?.[1]).toEqual({ accountId: 1, prId: 7, reviewId: 4 });
    getLatestSucceededReviewId.mockResolvedValueOnce(null);
    const none = await app.inject({ method: 'GET', url: '/api/pro/prs/7/ai-fix/preview' });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ error: 'ReviewUnavailable', message: 'Run a Claude review on this PR first.' });
    await app.close();
  });

  it('a malformed review id ⇒ 400; a review that is not this PR’s ⇒ 409 ReviewUnavailable', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/api/pro/prs/7/ai-fix/preview?sourceReviewId=x' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/pro/prs/7/ai-fix/preview?sourceReviewId=0' })).statusCode).toBe(400);
    loadFixPreview.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'GET', url: '/api/pro/prs/7/ai-fix/preview?sourceReviewId=99' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ReviewUnavailable');
    await app.close();
  });

  it('⚠ the reader’s `include` keys reach startFix as the selection (nothing stripped them)', async () => {
    const app = await build();
    const res = await start(app, { seed: 'review', sourceReviewId: 4, include: ['finding:31', 'thread:8'] });
    expect(res.statusCode).toBe(202);
    expect(startArg().selection).toEqual({ kind: 'keys', keys: ['finding:31', 'thread:8'] });
    await app.close();
  });

  it('no `include` ⇒ the defaults (no selection); a malformed one ⇒ 400 BadSelection, no run', async () => {
    const app = await build();
    await start(app, { seed: 'review', sourceReviewId: 4 });
    expect(startArg().selection).toBeUndefined();
    startFix.mockClear();
    for (const include of ['finding:31', [1, 2], [''], 'x'.repeat(3)]) {
      const res = await start(app, { seed: 'review', sourceReviewId: 4, include });
      expect(res.statusCode).toBe(400);
    }
    expect(startFix).not.toHaveBeenCalled();
    await app.close();
  });

  it('an empty selection ⇒ the manager’s NothingToFix, worded for the picker', async () => {
    const app = await build();
    startFix.mockResolvedValueOnce({ status: 'nothing_to_fix' } as never);
    const res = await start(app, { seed: 'review', sourceReviewId: 4, include: [] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'NothingToFix', message: 'Nothing is ticked.' });
    await app.close();
  });
});
