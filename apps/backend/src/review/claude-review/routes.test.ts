// POST /api/prs/:id/claude-review — the model default, the offered-model allow-list and the
// user-story caps.
//
// ⚠ A REAL Fastify with its DEFAULT ajv (so `removeAdditional` is in the path): an undeclared
// `ticket` key would be stripped SILENTLY, and the "a sent ticket reaches startReview" case below
// is the assertion that would catch it. The manager is mocked — no queue, no DB, no model.
//
//   pnpm --filter @pierre-review/backend test claude-review-routes
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentContext as ProContext } from '../agent-context.js';

const startReview = vi.fn(async () => ({ ok: true as const, reviewId: 123, queued: false }));

vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  startReview: (...args: unknown[]) => (startReview as (...a: unknown[]) => unknown)(...args),
  getReviewStatus: vi.fn(),
  listActiveReviews: vi.fn(async () => []),
  autoReviewHold: vi.fn(() => null),
  requestReviewCancel: vi.fn(() => false),
  subscribeReviewStream: vi.fn(() => () => {}),
}));

async function build(): Promise<{ app: FastifyInstance }> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ctx = {
    accountIdOf: () => 1,
    llm: { detectAuth: () => ({ status: 'ok' }) },
    review: {},
  } as any as ProContext;
  const { default: Fastify } = await import('fastify');
  const { registerClaudeReviewRoutes } = await import('./routes.js');
  const app = Fastify({ logger: false });
  registerClaudeReviewRoutes(app, ctx);
  await app.ready();
  return { app };
}

const post = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/prs/7/claude-review', payload: payload as object });

beforeEach(() => startReview.mockClear());

describe('the model', () => {
  it('no model ⇒ Opus 5.5, the default', async () => {
    const { app } = await build();
    const res = await post(app, {});
    expect(res.statusCode).toBe(202);
    expect(startReview).toHaveBeenCalledTimes(1);
    expect((startReview.mock.calls[0] as unknown[])[3]).toBe('claude-opus-5-5');
  });

  it("a retired id ('claude-opus-4-8', the old Opus) ⇒ 400, no run", async () => {
    const { app } = await build();
    const res = await post(app, { model: 'claude-opus-4-8' });
    expect(res.statusCode).toBe(400);
    expect(startReview).not.toHaveBeenCalled();
  });

  it("'claude-opus-5-5' and 'claude-sonnet-5' ⇒ 202", async () => {
    const { app } = await build();
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5']) {
      startReview.mockClear();
      const res = await post(app, { model });
      expect(res.statusCode).toBe(202);
      const call = startReview.mock.calls[0] as unknown[];
      expect(call[3]).toBe(model);
      expect(call).toHaveLength(4);
    }
  });

  it('the two dropped models (Sonnet 4.6, Haiku 4.5) ⇒ 400, no run', async () => {
    const { app } = await build();
    for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5']) {
      expect((await post(app, { model })).statusCode).toBe(400);
    }
    expect(startReview).not.toHaveBeenCalled();
  });

  it('a depth is no longer a choice: a stale `mode` is ignored and the router decides', async () => {
    const { app } = await build();
    const res = await post(app, { mode: 'worktree' });
    expect(res.statusCode).toBe(202);
    const call = startReview.mock.calls[0] as unknown[];
    expect(call).toHaveLength(4);
  });
});

// A PR review checks no story any more (the ticket review does). A stale `ticket`/`tickets` key
// from an older SPA is stripped by the schema, never validated, never passed to the run.
describe('a legacy user story on the PR review route', () => {
  it('is stripped: 202 and the run gets no story, even over the old caps', async () => {
    const { app } = await build();
    for (const payload of [
      { ticket: { title: 'Reset password', acceptanceCriteria: '- link sent\n- link expires' } },
      { tickets: [{ title: 'A' }, { title: 'B' }] },
      { ticket: { title: 'x'.repeat(5000) } },
    ]) {
      startReview.mockClear();
      const res = await post(app, payload);
      expect(res.statusCode).toBe(202);
      expect(startReview.mock.calls[0] as unknown[]).toHaveLength(4);
    }
  });
});

describe('the auto-review lock', () => {
  it('an auto review queued or running ⇒ 409 AutoReviewInProgress', async () => {
    const { app } = await build();
    for (const auto of ['queued', 'running'] as const) {
      (startReview as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
        ok: false,
        reason: 'auto_in_progress',
        auto,
      });
      const res = await post(app, {});
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'AutoReviewInProgress',
        auto,
        message: auto === 'running' ? 'Auto review running.' : 'Auto review queued.',
      });
    }
  });
});

// The per-ticket "Post as comment" is RETIRED: a story's results reach GitHub as findings (Post /
// Submit review), so the route is gone, not merely refused.
describe('the retired ticket post route', () => {
  it('POST /api/claude-reviews/:reviewId/tickets/:index/post ⇒ 404 (no such route)', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/claude-reviews/5/tickets/0/post' });
    expect(res.statusCode).toBe(404);
    expect(app.printRoutes()).not.toContain('tickets');
  });
});
