// THE AGENTIC FEATURES' REGISTRATION GATE (review/agentic.ts). Claude Review and AI Fix are core,
// free. What is pinned:
//
//   1. LIMN_AI_DISABLED=true (the kill switch) registers nothing.
//   2. Without it, every agentic route family is there — no opt-in flag.
//
// `config` is read at import, so each case resets the module graph and sets env first.
//
//   pnpm --filter @pierre-review/backend test review/agentic
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROUTES: Array<{ method: 'GET' | 'POST' | 'PUT'; url: string }> = [
  { method: 'POST', url: '/api/prs/:id/claude-review' },
  { method: 'GET', url: '/api/claude-reviews/:reviewId/chat' },
  { method: 'PUT', url: '/api/workspaces/:id/auto-review' },
  { method: 'POST', url: '/api/pro/prs/:id/ai-fix' },
  { method: 'POST', url: '/api/pro/ai-fixes/:fixId/push' },
  // "Ask Claude about this sprint" (Activity → This Sprint) — agentic: cloud must register none of it.
  // ("Check against code" is REMOVED in both modes.)
  { method: 'POST', url: '/api/sprint-graph/ask' },
  // "Check against docs" on a story — agentic: cloud must register none of it.
  { method: 'GET', url: '/api/docs/story-alignment' },
  { method: 'POST', url: '/api/docs/story-alignment' },
];

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function registered(env: Record<string, string | undefined>): Promise<boolean[]> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.DATABASE_URL = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-agentic-gate.sqlite`;
  process.env.DISABLE_SCHEDULER = 'true';
  const { registerAgenticRoutes } = await import('./agentic.js');
  const { default: Fastify } = await import('fastify');
  const app = Fastify({ logger: false });
  registerAgenticRoutes(app);
  await app.ready();
  const out = ROUTES.map((r) => app.hasRoute(r));
  await app.close();
  return out;
}

describe('registerAgenticRoutes', () => {
  it('with no flag at all, registers every agentic route', async () => {
    const got = await registered({ LIMN_AI_DISABLED: undefined });
    expect(got).toEqual(ROUTES.map(() => true));
  });

  it('LIMN_AI_DISABLED=true registers nothing', async () => {
    const got = await registered({ LIMN_AI_DISABLED: 'true' });
    expect(got).toEqual(ROUTES.map(() => false));
  });
});
