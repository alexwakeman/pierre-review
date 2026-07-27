// The not-found handler's PRERENDERED-ROUTE resolution.
//
// The marketing site ships one static HTML file per route (apps/landing/prerender.mjs)
// so that anything which does not execute JavaScript — an AI agent, a link unfurler, a
// crawler on a render budget, a no-JS visitor — receives the real page instead of an
// empty SPA shell. @fastify/static, registered with `wildcard: false`, already answers
// `/pricing/` from its directory-index scan; it does NOT answer `/pricing`, which is the
// canonical, link-shaped form. Those fall through to the not-found handler, which is
// what this file covers.
//
// This is worth a test because the failure is SILENT: if the lookup breaks, every route
// falls back to the shell, the site still looks perfect in a browser (JS fills it in),
// and the only symptom is that machines stop being able to read it.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DEPLOYMENT_MODE = 'local';
process.env.DATABASE_URL = '/tmp/pierre-landing-routes-test.sqlite';
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let landingDir: string;

const SHELL = '<html>SHELL — the un-prerendered fallback</html>';
const page = (name: string) => `<html><h1>${name} page</h1></html>`;

beforeAll(async () => {
  landingDir = mkdtempSync(join(tmpdir(), 'pierre-landing-'));
  writeFileSync(join(landingDir, 'index.html'), SHELL);
  for (const route of ['pricing', 'privacy']) {
    mkdirSync(join(landingDir, route));
    writeFileSync(join(landingDir, route, 'index.html'), page(route));
  }
  // A directory WITHOUT an index.html — the built assets/ dir looks like this, and it
  // must never be mistaken for a route.
  mkdirSync(join(landingDir, 'assets'));
  writeFileSync(join(landingDir, 'assets', 'app.js'), 'console.log(1)');

  const { default: Fastify } = await import('fastify');
  const { default: fastifyStatic } = await import('@fastify/static');
  const { registerErrorHandler } = await import('./error-handler.js');

  app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: landingDir, prefix: '/', wildcard: false });
  registerErrorHandler(app, {
    serveSpa: false,
    serveLanding: true,
    publicDir: landingDir,
    publicLandingDir: landingDir,
  });
  await app.ready();
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('prerendered landing routes', () => {
  it('serves a route its OWN prerendered page, not the shell', async () => {
    const res = await get('/pricing');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('pricing page');
    expect(res.body).not.toContain('SHELL');
  });

  it('serves every prerendered route independently', async () => {
    for (const route of ['pricing', 'privacy']) {
      const res = await get(`/${route}`);
      expect(res.body, `/${route}`).toContain(`${route} page`);
    }
  });

  it('tolerates a trailing slash', async () => {
    // @fastify/static's directory-index scan normally wins here, but the handler must
    // resolve it identically if it ever does fall through.
    const res = await get('/pricing/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('pricing page');
  });

  it('falls back to the shell for an unknown path', async () => {
    // Still a 200 + client-routable document: the SPA renders its own 404 for a human,
    // and the shell's canonical points at home, which collapses the soft-404 for a crawler.
    const res = await get('/no-such-page');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SHELL');
  });

  it('does not treat an asset directory as a route', async () => {
    const res = await get('/assets');
    expect(res.body).toContain('SHELL');
  });

  it('never joins a request path onto the filesystem root', async () => {
    // The routes are resolved into a fixed Set at boot, so a URL can only ever SELECT an
    // entry that was found on disk — traversal is not defended against, it is
    // unrepresentable. These would all be escapes if the path were joined instead.
    for (const attack of [
      '/../package.json',
      '/..%2fpackage.json',
      '/pricing/../../etc/passwd',
      '/%2e%2e/index.js',
      '/pricing%2f..%2f..%2fetc%2fpasswd',
    ]) {
      const res = await get(attack);
      expect(res.body, attack).not.toContain('pricing page');
      expect(res.statusCode, attack).toBeLessThan(500);
    }
  });

  it('still returns a JSON 404 for an unknown /api route', async () => {
    const res = await get('/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'NotFound' });
  });
});
