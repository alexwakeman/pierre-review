// The site handler end to end, over a real HTTP server on an ephemeral port, against
// throwaway landing and demo folders.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTACT_LIMIT, TICKET_LIMIT, createSiteHandler, type Logger, type SiteOptions } from './app.js';
import { MIN_FILL_MS } from './contact.js';
import { DEMO_CSP, LANDING_CSP } from './security.js';

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const WEBHOOK = 'https://hooks.slack.com/services/T1/B2/secret';

let root: string;
let landing: string;
let demo: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'limn-site-'));
  landing = join(root, 'landing');
  demo = join(root, 'demo');
  mkdirSync(join(landing, 'contact'), { recursive: true });
  mkdirSync(join(landing, 'assets'), { recursive: true });
  mkdirSync(join(landing, 'media'), { recursive: true });
  writeFileSync(join(landing, 'index.html'), `<!doctype html><title>home</title>${'x'.repeat(4000)}`);
  writeFileSync(join(landing, 'contact', 'index.html'), '<!doctype html><title>contact</title>');
  writeFileSync(join(landing, '404.html'), '<!doctype html><title>not found</title>');
  writeFileSync(join(landing, 'assets', 'index-abc123.js'), `console.log(1);${' '.repeat(3000)}`);
  writeFileSync(join(landing, 'media', 'clip.mp4'), Buffer.from('0123456789'));
  mkdirSync(join(demo, 'assets'), { recursive: true });
  writeFileSync(join(demo, 'index.html'), '<!doctype html><title>demo</title>');
  writeFileSync(join(demo, 'assets', 'app-1.js'), 'demo();');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Running {
  base: string;
  server: Server;
  clock: { t: number };
  posts: unknown[];
}

async function start(over: Partial<SiteOptions> = {}): Promise<Running> {
  const clock = { t: 1_000_000_000_000 };
  const posts: unknown[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const server = createServer(
    createSiteHandler({
      landingDir: landing,
      demoDir: demo,
      contactWebhookUrl: WEBHOOK,
      ticketSecret: 'secret',
      canonicalOrigin: 'https://limn-review.com',
      hstsMaxAge: 31536000,
      trustProxyHops: 1,
      logger: quiet,
      fetchImpl: fakeFetch,
      now: () => clock.t,
      ...over,
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server, clock, posts };
}

async function stop(r: Running): Promise<void> {
  await new Promise<void>((done) => r.server.close(() => done()));
}

describe('the landing', () => {
  it('serves the home page and a route folder, with or without the trailing slash', async () => {
    const r = await start();
    try {
      const home = await fetch(`${r.base}/`);
      expect(home.status).toBe(200);
      expect(home.headers.get('content-type')).toContain('text/html');
      expect(home.headers.get('cache-control')).toBe('no-cache');
      expect(await home.text()).toContain('<title>home</title>');

      for (const p of ['/contact', '/contact/']) {
        const res = await fetch(`${r.base}${p}`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('<title>contact</title>');
      }
    } finally {
      await stop(r);
    }
  });

  it('answers an unknown path with the 404 page and a 404 status', async () => {
    const r = await start();
    try {
      const res = await fetch(`${r.base}/no-such-page`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('not found');
    } finally {
      await stop(r);
    }
  });

  it('refuses to leave the site folder', async () => {
    const r = await start();
    try {
      for (const p of ['/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fpackage.json']) {
        const res = await fetch(`${r.base}${p}`);
        expect(res.status).toBe(404);
      }
    } finally {
      await stop(r);
    }
  });

  it('caches hashed assets for a year and compresses text', async () => {
    const r = await start();
    try {
      const res = await fetch(`${r.base}/assets/index-abc123.js`, {
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      // fetch decodes gzip transparently; the header says it was compressed on the wire.
      expect(res.headers.get('content-encoding')).toBe('gzip');
      expect((await res.text()).startsWith('console.log(1);')).toBe(true);
    } finally {
      await stop(r);
    }
  });

  it('answers a byte range with 206, so the video can seek', async () => {
    const r = await start();
    try {
      const res = await fetch(`${r.base}/media/clip.mp4`, { headers: { range: 'bytes=2-5' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(res.headers.get('content-type')).toBe('video/mp4');
      expect(await res.text()).toBe('2345');

      const bad = await fetch(`${r.base}/media/clip.mp4`, { headers: { range: 'bytes=50-60' } });
      expect(bad.status).toBe(416);
    } finally {
      await stop(r);
    }
  });

  it('revalidates with an ETag', async () => {
    const r = await start();
    try {
      const first = await fetch(`${r.base}/contact`);
      const etag = first.headers.get('etag');
      expect(etag).toBeTruthy();
      const again = await fetch(`${r.base}/contact`, { headers: { 'if-none-match': etag ?? '' } });
      expect(again.status).toBe(304);
    } finally {
      await stop(r);
    }
  });
});

describe('the security headers', () => {
  it('sends the landing CSP, HSTS and the rest on a page', async () => {
    const r = await start();
    try {
      const res = await fetch(`${r.base}/`);
      expect(res.headers.get('content-security-policy')).toBe(LANDING_CSP);
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await stop(r);
    }
  });

  // Pinned because index.html's font comment relies on it: the fonts are self-hosted,
  // and a Google Fonts stylesheet or font file must be blocked.
  it('keeps fonts and styles same-origin on the landing', () => {
    expect(LANDING_CSP).toContain("font-src 'self'");
    expect(LANDING_CSP).toContain("style-src 'self' 'unsafe-inline'");
    expect(LANDING_CSP).not.toContain('fonts.googleapis.com');
    expect(LANDING_CSP).not.toContain('fonts.gstatic.com');
    expect(LANDING_CSP).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('sends the demo CSP under /demo/ and no-store JSON under /api', async () => {
    const r = await start();
    try {
      const d = await fetch(`${r.base}/demo/`);
      expect(d.headers.get('content-security-policy')).toBe(DEMO_CSP);
      const h = await fetch(`${r.base}/api/health`);
      expect(h.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(h.headers.get('cache-control')).toBe('no-store');
    } finally {
      await stop(r);
    }
  });

  it('redirects www to the apex', async () => {
    const r = await start();
    try {
      // Raw request: fetch() will not let us set Host.
      const { request } = await import('node:http');
      const res = await new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
        const req = request(`${r.base}/contact?x=1`, { headers: { host: 'www.limn-review.com' } }, (resp) => {
          resolve({ status: resp.statusCode ?? 0, location: resp.headers.location });
          resp.resume();
        });
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(301);
      expect(res.location).toBe('https://limn-review.com/contact?x=1');
    } finally {
      await stop(r);
    }
  });

  it('redirects the old domain to the canonical one, and serves only listed hosts that way', async () => {
    const r = await start({ redirectHosts: ['pierre-review.com', 'www.pierre-review.com'] });
    try {
      const { request } = await import('node:http');
      const hit = (host: string) =>
        new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
          const req = request(`${r.base}/getting-started`, { headers: { host } }, (resp) => {
            resolve({ status: resp.statusCode ?? 0, location: resp.headers.location });
            resp.resume();
          });
          req.on('error', reject);
          req.end();
        });
      for (const host of ['pierre-review.com', 'WWW.pierre-review.com:443']) {
        const res = await hit(host);
        expect(res.status).toBe(301);
        expect(res.location).toBe('https://limn-review.com/getting-started');
      }
      expect((await hit('something-else.up.railway.app')).status).not.toBe(301);
    } finally {
      await stop(r);
    }
  });
});

describe('the demo', () => {
  it('redirects /demo to /demo/ and serves its files', async () => {
    const r = await start();
    try {
      const bare = await fetch(`${r.base}/demo?x=1`, { redirect: 'manual' });
      expect(bare.status).toBe(301);
      expect(bare.headers.get('location')).toBe('/demo/?x=1');

      const index = await fetch(`${r.base}/demo/`);
      expect(await index.text()).toContain('<title>demo</title>');
      const asset = await fetch(`${r.base}/demo/assets/app-1.js`);
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    } finally {
      await stop(r);
    }
  });

  it('falls back to its index.html for app routes, but 404s a missing file', async () => {
    const r = await start();
    try {
      const route = await fetch(`${r.base}/demo/pr/42`);
      expect(route.status).toBe(200);
      expect(await route.text()).toContain('<title>demo</title>');
      const missing = await fetch(`${r.base}/demo/assets/nope.js`);
      expect(missing.status).toBe(404);
    } finally {
      await stop(r);
    }
  });

  it('shows a coming-soon page when no demo has been built', async () => {
    const r = await start({ demoDir: join(root, 'no-demo-here') });
    try {
      const res = await fetch(`${r.base}/demo/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('coming soon');
    } finally {
      await stop(r);
    }
  });
});

describe('the API', () => {
  it('reports health', async () => {
    const r = await start();
    try {
      const res = await fetch(`${r.base}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await stop(r);
    }
  });

  it('503s the ticket when no webhook is configured, so the form can say so', async () => {
    const r = await start({ contactWebhookUrl: '' });
    try {
      const res = await fetch(`${r.base}/api/contact/ticket`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'contact_unavailable' });
    } finally {
      await stop(r);
    }
  });

  it('delivers a message sent after the minimum fill time', async () => {
    const r = await start();
    try {
      const { ticket } = (await (await fetch(`${r.base}/api/contact/ticket`)).json()) as { ticket: string };
      r.clock.t += MIN_FILL_MS + 1;
      const res = await fetch(`${r.base}/api/contact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({
          name: 'Sam',
          email: 'sam@example.com',
          topic: 'licence',
          message: 'Twelve of us.',
          ticket,
          website: '',
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(r.posts).toHaveLength(1);
      expect(JSON.stringify(r.posts[0])).toContain('Licence for a bigger team');
    } finally {
      await stop(r);
    }
  });

  it('drops a filled honeypot with the success shape and posts nothing', async () => {
    const r = await start();
    try {
      const { ticket } = (await (await fetch(`${r.base}/api/contact/ticket`)).json()) as { ticket: string };
      r.clock.t += MIN_FILL_MS + 1;
      const res = await fetch(`${r.base}/api/contact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bot', email: 'b@example.com', message: 'buy', ticket, website: 'spam.example' }),
      });
      expect(res.status).toBe(200);
      expect(r.posts).toHaveLength(0);
    } finally {
      await stop(r);
    }
  });

  it('refuses a form sent too fast, and a cross-site post', async () => {
    const r = await start();
    try {
      const { ticket } = (await (await fetch(`${r.base}/api/contact/ticket`)).json()) as { ticket: string };
      const fast = await fetch(`${r.base}/api/contact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'A', email: 'a@example.com', message: 'hi', ticket }),
      });
      expect(fast.status).toBe(400);
      expect(((await fast.json()) as { error: string }).error).toBe('ticket_invalid');

      const cross = await fetch(`${r.base}/api/contact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: '{}',
      });
      expect(cross.status).toBe(403);
      expect(r.posts).toHaveLength(0);
    } finally {
      await stop(r);
    }
  });

  it('rate-limits by the address our proxy saw, not the one the client wrote', async () => {
    const r = await start();
    try {
      const post = (xff: string): Promise<Response> =>
        fetch(`${r.base}/api/contact`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
          body: JSON.stringify({ name: 'A', email: 'a@example.com', message: 'hi', ticket: 'x' }),
        });
      // A bot rotating the leftmost entry is still one client to us.
      for (let i = 0; i < CONTACT_LIMIT; i++) {
        expect((await post(`10.0.0.${i}, 203.0.113.9`)).status).toBe(400);
      }
      const over = await post('10.0.0.99, 203.0.113.9');
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toBeTruthy();
      // A different real client is unaffected.
      expect((await post('203.0.113.10')).status).toBe(400);
    } finally {
      await stop(r);
    }
  });

  it('gives the ticket its own, looser limit, so reloading the page cannot lock the form', async () => {
    const r = await start();
    try {
      const get = (): Promise<Response> =>
        fetch(`${r.base}/api/contact/ticket`, { headers: { 'x-forwarded-for': '203.0.113.20' } });
      // Well past the submit limit, the ticket still mints...
      for (let i = 0; i < TICKET_LIMIT; i++) expect((await get()).status).toBe(200);
      // ...until its own bucket runs out.
      const over = await get();
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toBeTruthy();

      // And fetching tickets spent none of the submit bucket.
      const { ticket } = (await (
        await fetch(`${r.base}/api/contact/ticket`, { headers: { 'x-forwarded-for': '203.0.113.21' } })
      ).json()) as { ticket: string };
      r.clock.t += MIN_FILL_MS + 1;
      const sent = await fetch(`${r.base}/api/contact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.20' },
        body: JSON.stringify({ name: 'Sam', email: 'sam@example.com', message: 'Hello.', ticket }),
      });
      expect(sent.status).toBe(200);
    } finally {
      await stop(r);
    }
  });

  it('404s an unknown API path and 405s a wrong method', async () => {
    const r = await start();
    try {
      expect((await fetch(`${r.base}/api/auth/login`)).status).toBe(404);
      expect((await fetch(`${r.base}/api/contact`)).status).toBe(405);
      expect((await fetch(`${r.base}/`, { method: 'POST' })).status).toBe(405);
    } finally {
      await stop(r);
    }
  });
});
