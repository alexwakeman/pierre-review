// ghRestGetConditional — the adaptive probe's REST read. It REPORTS a non-2xx rather than
// throwing, so the caller must classify; this pins that a limiter's answer is flagged
// (`rateLimited`, through the one `isRateLimitError`) and nothing else is.
import { afterEach, describe, expect, it } from 'vitest';
import { ghRestGetConditional } from './client.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: string, headers: Record<string, string> = {}): void {
  globalThis.fetch = (async () =>
    new Response(status === 304 ? null : body, { status, headers })) as unknown as typeof fetch;
}

describe('ghRestGetConditional', () => {
  it('a 304 is not modified, with no limit flag', async () => {
    answer(304, '', { etag: 'W/"a"' });
    expect(await ghRestGetConditional('tok', '/x', 'W/"a"')).toEqual({
      status: 304,
      notModified: true,
      etag: 'W/"a"',
    });
  });

  it('a 429 is rate limited, resuming per Retry-After', async () => {
    answer(429, '{"message":"slow down"}', { 'retry-after': '30' });
    const r = await ghRestGetConditional('tok', '/x', null);
    expect(r.status).toBe(429);
    expect(r.notModified).toBe(false);
    expect(r.rateLimited).toBeDefined();
    expect(r.rateLimited!.resumeAt!.getTime()).toBeGreaterThan(Date.now() + 25_000);
  });

  it('a 403 secondary-limit message, or an exhausted primary window, is rate limited', async () => {
    answer(403, '{"message":"You have exceeded a secondary rate limit."}');
    expect((await ghRestGetConditional('tok', '/x', null)).rateLimited).toBeDefined();
    answer(403, '{"message":"Forbidden"}', {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '9999999999',
    });
    expect((await ghRestGetConditional('tok', '/x', null)).rateLimited).toBeDefined();
  });

  it('a plain 403 / 404 / 500 is reported, not flagged as a limit', async () => {
    answer(403, '{"message":"Resource not accessible by integration"}', {
      'x-ratelimit-remaining': '4000',
    });
    expect((await ghRestGetConditional('tok', '/x', null)).rateLimited).toBeUndefined();
    answer(404, '{"message":"Not Found"}');
    expect(await ghRestGetConditional('tok', '/x', null)).toMatchObject({
      status: 404,
      notModified: false,
    });
    answer(500, 'oops');
    expect((await ghRestGetConditional('tok', '/x', null)).rateLimited).toBeUndefined();
  });
});
