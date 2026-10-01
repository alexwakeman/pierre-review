// THE AGENTIC FEATURES' REGISTRATION GATE (review/agentic.ts). Claude Review, review memory and AI
// Fix are core, free and LOCAL ONLY. What is pinned:
//
//   1. ⚠ CLOUD REGISTERS NOTHING — an explicit `isCloud` check, so the guarantee never rests on an
//      env var being unset (it used to: the plugin's PRO_ADVANCED_AI_ENABLED).
//   2. LIMN_AI_DISABLED=true (the kill switch) registers nothing locally either.
//   3. Locally, with neither, every agentic route family is there — no opt-in flag.
//
// `config` is read at import, so each case resets the module graph and sets env first.
//
//   pnpm --filter @pierre-review/backend test review/agentic
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROUTES: Array<{ method: 'GET' | 'POST' | 'PUT'; url: string }> = [
  { method: 'POST', url: '/api/prs/:id/claude-review' },
  { method: 'GET', url: '/api/claude-reviews/:reviewId/chat' },
  { method: 'PUT', url: '/api/workspaces/:id/auto-review' },
  { method: 'GET', url: '/api/pro/prs/:id/review-learnings' },
  { method: 'POST', url: '/api/pro/prs/:id/ai-fix' },
  { method: 'POST', url: '/api/pro/ai-fixes/:fixId/push' },
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
  process.env.DATABASE_URL = '/tmp/pierre-agentic-gate.sqlite';
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
  it('locally, with no flag at all, registers every agentic route', async () => {
    const got = await registered({ DEPLOYMENT_MODE: 'local', LIMN_AI_DISABLED: undefined });
    expect(got).toEqual(ROUTES.map(() => true));
  });

  it('⚠ in cloud registers NOTHING', async () => {
    const got = await registered({ DEPLOYMENT_MODE: 'cloud', LIMN_AI_DISABLED: undefined });
    expect(got).toEqual(ROUTES.map(() => false));
  });

  it('LIMN_AI_DISABLED=true registers nothing locally', async () => {
    const got = await registered({ DEPLOYMENT_MODE: 'local', LIMN_AI_DISABLED: 'true' });
    expect(got).toEqual(ROUTES.map(() => false));
  });
});
