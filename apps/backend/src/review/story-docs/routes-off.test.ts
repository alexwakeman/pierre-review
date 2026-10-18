// THE SECOND GUARD: with agentic AI off (LIMN_AI_DISABLED=true) the story docs routes answer 404 even
// when registered directly (registerAgenticRoutes would not register them at all — agentic.test.ts).
import { afterAll, describe, expect, it, vi } from 'vitest';

const saved = { ...process.env };
afterAll(() => {
  process.env = { ...saved };
  vi.resetModules();
});

describe('story docs routes with agentic AI off', () => {
  it('404 on both routes', async () => {
    vi.resetModules();
    process.env.LIMN_AI_DISABLED = 'true';
    process.env.DEPLOYMENT_MODE = 'local';
    process.env.DISABLE_SCHEDULER = 'true';
    process.env.DATABASE_URL = '/tmp/pierre-storydocs-off.sqlite';
    const { registerStoryDocsRoutes } = await import('./routes.js');
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    registerStoryDocsRoutes(app, { accountIdOf: () => 1 } as any);
    await app.ready();
    const ident = encodeURIComponent('jira:https://acme.atlassian.net#ABC-1');
    expect((await app.inject({ method: 'GET', url: `/api/docs/story-alignment?ident=${ident}` })).statusCode).toBe(404);
    const post = await app.inject({ method: 'POST', url: '/api/docs/story-alignment', payload: { ident: 'jira:https://acme.atlassian.net#ABC-1' } });
    expect(post.statusCode).toBe(404);
    expect(post.json().message).toMatch(/npx limn-review/);
    await app.close();
  });
});
