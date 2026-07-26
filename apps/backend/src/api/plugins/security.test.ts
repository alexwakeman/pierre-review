// Security-plugin tests: the origin allowlist, the cross-origin state-change guard, and the
// Host guard. Driven through a real Fastify instance with `app.inject` so the hooks run in the
// order they will in production.
//
// LOCAL MODE is what these cover, because local mode is where the hole was: it has no auth at
// all (every request resolves to the single implicit account), so CORS `origin: true` meant any
// page the developer happened to have open could read their whole synced GitHub dataset and
// drive their write actions. Env is set BEFORE importing config, per the retention.test.ts
// pattern.
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DEPLOYMENT_MODE = 'local';
process.env.DATABASE_URL = '/tmp/pierre-security-test.sqlite';
process.env.DISABLE_SCHEDULER = 'true';
process.env.RATE_LIMIT_DISABLED = 'true'; // isolate the guards from the limiter

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let isAllowedOrigin: (o: string) => boolean;

beforeAll(async () => {
  const security = await import('./security.js');
  isAllowedOrigin = security.isAllowedOrigin;

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  security.registerSecurityHeaders(app);
  security.registerHostGuard(app);
  security.registerCrossOriginGuard(app);

  // Stand-ins for a read, a state-changing write, the guarded mutating GET, and an
  // HMAC-authenticated webhook.
  app.get('/api/timeline', async () => ({ ok: true }));
  app.post('/api/repos/1/sync', async () => ({ started: true }));
  app.get('/api/auth/reconnect', async () => ({ reconnecting: true }));
  app.post('/api/webhooks/github', async () => ({ received: true }));
  app.get('/app/', async () => 'spa');
  await app.ready();
});

const LOCALHOST = { host: 'localhost:4000' };

describe('isAllowedOrigin (local mode)', () => {
  it('accepts loopback origins on any port', () => {
    // Any port, because the legitimate ports are not knowable here: Vite dev (5173), the landing
    // dev server (5174), the isolated demo stack (5273), and whatever PORT the packaged CLI uses.
    for (const o of [
      'http://localhost:5173',
      'http://localhost:4000',
      'http://127.0.0.1:4100',
      'http://[::1]:5273',
      'https://localhost:8443',
    ]) {
      expect(isAllowedOrigin(o), o).toBe(true);
    }
  });

  it('rejects real websites — the case that actually mattered', () => {
    for (const o of [
      'https://evil.example',
      'http://attacker.test:4000',
      // Not a loopback host, however much it looks like one.
      'https://localhost.evil.example',
      'https://127.0.0.1.evil.example',
      'null',
      'not-a-url',
    ]) {
      expect(isAllowedOrigin(o), o).toBe(false);
    }
  });
});

describe('cross-origin state-change guard', () => {
  it('allows a same-origin write (the app itself)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/1/sync',
      headers: { ...LOCALHOST, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows a user-initiated navigation (sec-fetch-site: none)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/1/sync',
      headers: { ...LOCALHOST, 'sec-fetch-site': 'none' },
    });
    expect(res.statusCode).toBe(200);
  });

  // The core of it. A cross-origin POST is DELIVERED regardless of CORS — CORS only decides
  // whether the attacker's page may read the RESPONSE. In local mode there is no cookie to
  // miss, so without this guard the write simply executed as the local user.
  it('BLOCKS a cross-site write', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/1/sync',
      headers: {
        ...LOCALHOST,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Forbidden');
  });

  it('falls back to Origin when Sec-Fetch-Site is absent (older browsers)', async () => {
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/repos/1/sync',
      headers: { ...LOCALHOST, origin: 'https://evil.example' },
    });
    expect(blocked.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/repos/1/sync',
      headers: { ...LOCALHOST, origin: 'http://localhost:5173' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('allows header-less clients (curl, the CLI, integrations)', async () => {
    // CSRF requires a browser; blocking header-less requests would break every script.
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/1/sync',
      headers: LOCALHOST,
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not block reads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/timeline',
      headers: { ...LOCALHOST, 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(200);
  });

  // /api/auth/reconnect revokes the GitHub grant and drops the session, so it needs POST-grade
  // protection despite being a GET.
  it('guards the mutating GET /api/auth/reconnect', async () => {
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/auth/reconnect',
      headers: { ...LOCALHOST, 'sec-fetch-site': 'cross-site' },
    });
    expect(blocked.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/auth/reconnect',
      headers: { ...LOCALHOST, 'sec-fetch-site': 'same-origin' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  // GitHub/Stripe send neither Origin nor Sec-Fetch-*; they authenticate by HMAC instead.
  it('exempts the signed webhook receivers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: { ...LOCALHOST, 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Host guard (DNS rebinding)', () => {
  it('allows loopback Host values', async () => {
    for (const host of ['localhost:4000', '127.0.0.1:4000', 'localhost', '[::1]:4000']) {
      const res = await app.inject({ method: 'GET', url: '/api/timeline', headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
  });

  // The server binds 127.0.0.1, so nothing on the network can reach it — but an attacker can
  // make a hostname they control RESOLVE there, at which point their page is same-origin and
  // every origin check above stops helping. A rebound request still carries their Host.
  it('rejects a rebound Host', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/timeline',
      headers: { host: 'evil.example:4000' },
    });
    expect(res.statusCode).toBe(421);
  });
});

describe('security headers', () => {
  it('sets a strict CSP + the hardening headers on API responses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/timeline',
      headers: LOCALHOST,
    });
    // API responses are never documents: nothing may load or run out of one.
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // PR data must not land in a browser or proxy cache.
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('sends the SPA CSP for /app, naming no third party in local mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/', headers: LOCALHOST });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    // Inline styles are unavoidable (React style attrs + vis-timeline positioning) …
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // … but scripts stay strict: no 'unsafe-inline', no 'unsafe-eval'.
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('unsafe-eval');
    // Third-party markdown images are allowed; the font is self-hosted.
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("font-src 'self'");
    // Local mode phones home to nobody — no Google origins in the policy.
    expect(csp).not.toContain('googletagmanager');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('does not send HSTS in local mode (it would pin localhost to HTTPS)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/timeline', headers: LOCALHOST });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
