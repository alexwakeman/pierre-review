// "Resolve with Claude" is AGENTIC, so it follows the agentic rule: nothing registers in cloud. The
// resolver's own seven routes stay in both modes; this one must 404 there.
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

process.env.DATABASE_URL = '/tmp/pierre-ai-resolve-cloud-test.sqlite';
process.env.DISABLE_SCHEDULER = 'true';

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return { config: { ...real.config, isCloud: true, aiEnabled: false } };
});

import { agenticAllowed, registerAgenticRoutes } from '../../review/agentic.js';

describe('Resolve with Claude in cloud', () => {
  it('is not registered at all', async () => {
    expect(agenticAllowed()).toBe(false);
    const app = Fastify();
    expect(registerAgenticRoutes(app)).toBeNull();
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/prs/7/conflicts/ai-resolve', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
