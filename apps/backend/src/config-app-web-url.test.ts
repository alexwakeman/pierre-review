import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── config.appWebUrl: WHERE A PERSON'S BROWSER REACHES THE SPA ──────────────────────────────
//
// The regression under test shipped as 404ing Slack deep links: the digest built its links on
// `config.appBaseUrl` — this SERVER's origin — and under `pnpm dev` that is :4000, which serves
// no SPA at all. Vite serves it on :5173.
//
// config.ts resolves both values at MODULE LOAD from `process.env`, so each case here mutates the
// environment and re-imports through `vi.resetModules()`. `vi.stubEnv` is deliberately not used:
// it restores between tests but does not re-evaluate an already-imported module.
//
// ⚠ `serverServesSpa` is false throughout this file, and that is not a stub — it is the real
// answer. It keys on the built SPA sitting next to the compiled server (`apps/backend/public/
// index.html`), which exists only in a packaged release. Under vitest, as under `pnpm dev`,
// nothing is there. The "this server DOES serve the SPA" arm is therefore asserted through its
// observable consequence (§ the two agree) rather than by faking the filesystem.
describe('config.appWebUrl', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.APP_WEB_URL;
    delete process.env.APP_BASE_URL;
    delete process.env.FRONTEND_PORT;
    delete process.env.PORT;
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  const load = async () => await import('./config.js');

  it('points at the Vite dev origin when this server does not serve the SPA', async () => {
    const { config, serverServesSpa } = await load();
    // The precondition, asserted rather than assumed — if a stray public/index.html ever appears
    // in the source tree this test would otherwise pass for the wrong reason.
    expect(serverServesSpa).toBe(false);
    expect(config.appWebUrl).toBe('http://localhost:5173');
  });

  it('does NOT follow APP_BASE_URL when nothing here serves the SPA', async () => {
    // THE REGRESSION, PINNED. docs/LOCAL-CLOUD-TESTING.md § Option A runs `DEPLOYMENT_MODE=cloud
    // pnpm dev` with APP_BASE_URL=:4000 set (the OAuth callback needs it) while Vite still serves
    // the SPA. Keying appWebUrl on "is APP_BASE_URL set" would put that mode back on the 404.
    process.env.APP_BASE_URL = 'http://localhost:4000';
    const { config } = await load();
    expect(config.appBaseUrl).toBe('http://localhost:4000'); // the API origin is untouched…
    expect(config.appWebUrl).toBe('http://localhost:5173'); // …and the browser origin differs
  });

  it('APP_WEB_URL overrides everything, for a split deployment', async () => {
    process.env.APP_BASE_URL = 'https://api.example.com';
    process.env.APP_WEB_URL = 'https://app.example.com/';
    const { config } = await load();
    expect(config.appWebUrl).toBe('https://app.example.com'); // trailing slash stripped
    expect(config.appBaseUrl).toBe('https://api.example.com');
  });

  it('FRONTEND_PORT moves the dev origin, for the demo stack on :5273', async () => {
    process.env.FRONTEND_PORT = '5273';
    const { config } = await load();
    expect(config.appWebUrl).toBe('http://localhost:5273');
  });

  it('a blank or whitespace APP_WEB_URL falls through instead of emitting a hostless link', async () => {
    process.env.APP_WEB_URL = '   ';
    const { config } = await load();
    expect(config.appWebUrl).toBe('http://localhost:5173');
  });

  it('never resolves to an empty string — a hostless link is the failure mode being prevented', async () => {
    for (const env of [{}, { APP_BASE_URL: 'http://localhost:4000' }, { FRONTEND_PORT: '3000' }]) {
      vi.resetModules();
      delete process.env.APP_WEB_URL;
      delete process.env.APP_BASE_URL;
      delete process.env.FRONTEND_PORT;
      Object.assign(process.env, env);
      const { config } = await load();
      expect(config.appWebUrl).toMatch(/^https?:\/\/.+/);
    }
  });
});
