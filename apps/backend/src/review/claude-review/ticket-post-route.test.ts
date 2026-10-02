// POST /api/claude-reviews/:reviewId/tickets/:index/post — ONE ticket's analysis as a PR-level
// comment. What is pinned:
//   1. it posts the templated body through `ctx.prWrites.postPrComment` and records it per ticket;
//   2. ⚠ ONCE PER TICKET: a posted ticket answers 409 AlreadyPosted, and a double click (two POSTs
//      before the first returns) posts once;
//   3. nothing to post (run not succeeded / not_checked) ⇒ 409 NotReady; unknown index ⇒ 404;
//   4. ⚠ once GitHub answered, a failed record still answers 200 with visible:false, and the
//      ticket is refused from then on (a retry would double-post).
//
//   pnpm --filter @pierre-review/backend test ticket-post-route
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentContext } from '../agent-context.js';

vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  startReview: vi.fn(),
  getReviewStatus: vi.fn(),
  listActiveReviews: vi.fn(async () => []),
  autoReviewHold: vi.fn(() => null),
  requestReviewCancel: vi.fn(() => false),
  subscribeReviewStream: vi.fn(() => () => {}),
}));

const assessment = {
  alignment: 'aligned' as string,
  summary: 'Done.',
  criteria: [],
  missing: [],
  notRequested: [],
  posted: null as unknown,
};
let status = 'succeeded';
const marked: unknown[] = [];
let markFails = false;
vi.mock('./persist.js', async (orig) => ({
  ...(await orig<typeof import('./persist.js')>()),
  getTicketPostContext: async (_ctx: unknown, reviewId: number, accountId: number) =>
    reviewId === 5 && accountId === 1
      ? {
          reviewId,
          prId: 77,
          status,
          reviewHeadSha: 'abcdef1234',
          owner: 'acme',
          name: 'api',
          prNumber: 3,
          tickets: [{ title: 'Reset', description: null, acceptanceCriteria: null, key: 'ENG-1' }],
          assessments: [assessment],
        }
      : null,
  markTicketPosted: async (_ctx: unknown, reviewId: number, index: number, posted: unknown) => {
    if (markFails) throw new Error('db down');
    marked.push({ reviewId, index, posted });
    assessment.posted = posted;
  },
}));

let posts: Array<{ prId: number; body: string }> = [];
let gate: Promise<void> = Promise.resolve();
async function build(): Promise<FastifyInstance> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ctx = {
    accountIdOf: () => 1,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    prWrites: {
      postPrComment: async (_a: number, prId: number, body: string) => {
        await gate;
        posts.push({ prId, body });
        return { githubCommentId: '900', url: 'https://github.com/acme/api/pull/3#issuecomment-900', createdAt: '2026-10-02T10:00:00.000Z', visible: true };
      },
    },
  } as any as AgentContext;
  const { default: Fastify } = await import('fastify');
  const { registerClaudeReviewRoutes } = await import('./routes.js');
  const app = Fastify({ logger: false });
  registerClaudeReviewRoutes(app, ctx);
  await app.ready();
  return app;
}

const postTicket = (app: FastifyInstance, reviewId = 5, index = 0) =>
  app.inject({ method: 'POST', url: `/api/claude-reviews/${reviewId}/tickets/${index}/post` });

beforeEach(() => {
  posts = [];
  marked.length = 0;
  assessment.posted = null;
  assessment.alignment = 'aligned';
  status = 'succeeded';
  markFails = false;
  gate = Promise.resolve();
});

describe('posting a ticket analysis', () => {
  it('posts the templated comment once and records it', async () => {
    const app = await build();
    const res = await postTicket(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      githubCommentId: '900',
      url: 'https://github.com/acme/api/pull/3#issuecomment-900',
      postedAt: '2026-10-02T10:00:00.000Z',
      visible: true,
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.prId).toBe(77);
    expect(posts[0]!.body).toContain('### ENG-1 · Reset');
    expect(marked).toHaveLength(1);
    const again = await postTicket(app);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('AlreadyPosted');
    expect(posts).toHaveLength(1);
  });

  it('⚠ a double click posts once', async () => {
    const app = await build();
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const a = postTicket(app);
    const b = postTicket(app);
    await new Promise((r) => setTimeout(r, 20));
    open();
    const codes = [(await a).statusCode, (await b).statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(posts).toHaveLength(1);
  });

  it('nothing to post ⇒ 409 NotReady; unknown ticket or review ⇒ 404', async () => {
    const app = await build();
    assessment.alignment = 'not_checked';
    expect((await postTicket(app)).json().error).toBe('NotReady');
    assessment.alignment = 'aligned';
    status = 'failed';
    expect((await postTicket(app)).statusCode).toBe(409);
    status = 'succeeded';
    expect((await postTicket(app, 5, 3)).statusCode).toBe(404);
    expect((await postTicket(app, 6, 0)).statusCode).toBe(404);
    expect(posts).toHaveLength(0);
  });

  // Keep LAST: a failed record refuses that ticket for the life of the process.
  it('⚠ GitHub answered but the record failed ⇒ still 200 with the comment id', async () => {
    const app = await build();
    markFails = true;
    const res = await postTicket(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().githubCommentId).toBe('900');
    // Not confirmed locally, so the SPA must not offer a retry — and a retry is refused anyway.
    expect(res.json().visible).toBe(false);
    markFails = false;
    const again = await postTicket(app);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('AlreadyPosted');
    expect(posts).toHaveLength(1);
  });
});
