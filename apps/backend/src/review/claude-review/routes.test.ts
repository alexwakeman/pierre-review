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
import { CLAUDE_REVIEW_TICKET_LIMITS } from '@pierre-review/shared';
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
      expect(call[4]).toEqual([]);
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
    expect(call).toHaveLength(5);
    expect(call[4]).toEqual([]);
  });
});

describe('the user story', () => {
  const L = CLAUDE_REVIEW_TICKET_LIMITS;

  it('title over the cap ⇒ 400 TicketInvalid naming the field, no run', async () => {
    const { app } = await build();
    const res = await post(app, { ticket: { title: 'x'.repeat(L.titleChars + 1) } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'TicketInvalid', field: 'title' });
    expect(res.json().message).toBe('Title is 301 characters; the limit is 300.');
    expect(startReview).not.toHaveBeenCalled();
  });

  it('criteria text over the character cap ⇒ 400; any number of lines is fine', async () => {
    const { app } = await build();
    const over = await post(app, { ticket: { acceptanceCriteria: 'x'.repeat(L.acceptanceCriteriaChars + 1) } });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ error: 'TicketInvalid', field: 'acceptanceCriteria' });
    expect(startReview).not.toHaveBeenCalled();
    const many = Array.from({ length: 80 }, (_, i) => `- c${i}`).join('\n');
    expect((await post(app, { ticket: { acceptanceCriteria: many } })).statusCode).toBe(202);
  });

  it('a ticket exactly at every cap ⇒ 202, normalised, criteria stored unsplit', async () => {
    const { app } = await build();
    const criteria = 'c'.repeat(L.acceptanceCriteriaChars);
    const res = await post(app, {
      ticket: {
        title: ` ${'t'.repeat(L.titleChars)} `,
        description: 'd'.repeat(L.descriptionChars),
        acceptanceCriteria: criteria,
      },
    });
    expect(res.statusCode).toBe(202);
    const t = ((startReview.mock.calls[0] as unknown[])[4] as Array<{ title: string; acceptanceCriteria: string }>)[0]!;
    expect(t.title).toBe('t'.repeat(L.titleChars));
    expect(t.acceptanceCriteria).toBe(criteria);
  });

  it('an all-empty ticket ⇒ no ticket', async () => {
    const { app } = await build();
    const res = await post(app, { ticket: { title: '  ', description: '', acceptanceCriteria: '\n' } });
    expect(res.statusCode).toBe(202);
    expect((startReview.mock.calls[0] as unknown[])[4]).toEqual([]);
  });

  it('a sent ticket reaches startReview (ajv did not strip it)', async () => {
    const { app } = await build();
    const res = await post(app, {
      model: 'claude-sonnet-5',
      ticket: { title: 'Reset password', acceptanceCriteria: '- link sent\n- link expires' },
    });
    expect(res.statusCode).toBe(202);
    expect((startReview.mock.calls[0] as unknown[])[4]).toEqual([
      {
        title: 'Reset password',
        description: null,
        acceptanceCriteria: '- link sent\n- link expires',
      },
    ]);
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
