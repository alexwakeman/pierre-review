// THE SECOND GUARD: with agentic AI off (LIMN_AI_DISABLED=true) the "Implement story" routes answer 404 even
// when registered directly (registerAgenticRoutes would not register them at all — agentic.test.ts).
import { afterAll, describe, expect, it, vi } from 'vitest';

const saved = { ...process.env };
afterAll(() => {
  process.env = { ...saved };
  vi.resetModules();
});

describe('story build routes with agentic AI off', () => {
  it('404 on every session route', async () => {
    vi.resetModules();
    process.env.LIMN_AI_DISABLED = 'true';
    process.env.DISABLE_SCHEDULER = 'true';
    process.env.DATABASE_URL = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-storybuild-off.sqlite`;
    const { registerStoryBuildRoutes } = await import('./routes.js');
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    registerStoryBuildRoutes(app, { accountIdOf: () => 1 } as any);
    await app.ready();
    const ident = encodeURIComponent('jira:https://acme.atlassian.net#ABC-1');
    for (const [method, url, payload] of [
      ['GET', `/api/story-builds?ident=${ident}`, undefined],
      ['GET', '/api/story-builds/1', undefined],
      ['GET', '/api/story-builds/1/stream', undefined],
      ['POST', '/api/story-builds', { ident: 'jira:https://acme.atlassian.net#ABC-1' }],
      ['POST', '/api/story-builds/1/plan/message', { text: 'x' }],
      ['POST', '/api/story-builds/1/accept', { planRevision: 1, repos: [] }],
      ['POST', '/api/story-builds/1/cancel', {}],
      ['POST', '/api/story-builds/1/discard', {}],
    ] as const) {
      const r = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
      expect(r.json().message).toMatch(/npx limn-review/);
    }
    await app.close();
  });
});
