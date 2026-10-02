// POST /api/claude-reviews/:reviewId/post must not post a finding that is ALREADY on GitHub.
// The SPA offers no "Post again" once a finding is posted (singly, or inside an earlier review), so
// a re-submitted review that still carried it would put the same comment on the PR twice.
//
//   pnpm --filter @pierre-review/backend test post-review-skips-posted
import { describe, expect, it, vi } from 'vitest';
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

const finding = (id: number, included: boolean, postedAt: string | null) => ({
  id,
  path: 'src/a.ts',
  line: id,
  side: 'RIGHT',
  anchored: true,
  fileInDiff: true,
  body: `finding ${id}`,
  editedBody: null,
  suggestion: null,
  included,
  postedAt,
});

vi.mock('./persist.js', async (orig) => ({
  ...(await orig<typeof import('./persist.js')>()),
  getReviewPostContext: async () => ({
    owner: 'acme',
    name: 'api',
    prNumber: 3,
    reviewHeadSha: 'abc',
  }),
  getClaudeReviewById: async () => ({
    id: 5,
    userBody: '',
    findings: [
      finding(1, true, null),
      finding(2, true, '2026-10-01T10:00:00.000Z'),
      finding(3, false, null),
    ],
  }),
  updateReviewDraft: async () => {},
  markReviewPosted: async () => {},
}));

describe('posting a review', () => {
  it('sends only included findings that are not already posted', async () => {
    const sent: number[][] = [];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const ctx = {
      accountIdOf: () => 1,
      log: { warn: () => {}, info: () => {}, error: () => {} },
      review: {
        postReview: async (args: { includedFindings: Array<{ id: number }> }) => {
          sent.push(args.includedFindings.map((f) => f.id));
          return { preview: { comments: [], prComments: [], event: 'COMMENT', body: '' } };
        },
      },
    } as any as AgentContext;
    const { default: Fastify } = await import('fastify');
    const { registerClaudeReviewRoutes } = await import('./routes.js');
    const app = Fastify({ logger: false });
    registerClaudeReviewRoutes(app, ctx);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/claude-reviews/5/post?dryRun=true',
      payload: { userVerdict: 'COMMENT' },
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toEqual([[1]]);
    await app.close();
  });
});
