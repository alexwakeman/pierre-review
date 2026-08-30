// THE PAYWALL ON `GET /api/pro/bot-benchmark`, PINNED IN BOTH DIRECTIONS.
//
// ⚠ WHY THIS FILE EXISTS. The benchmark route is PLUGIN-owned and carries no gate of its own for
// the per-account tier: its 402 comes entirely from the host's AUTOMATIC `/api/pro/*` gate
// (`registerAuthGate` → `isProPath`). That is the cheapest possible entitlement — and the most
// deletable, because nothing in the route file mentions it. Move the route to `/api/bot-benchmark`
// "for symmetry with /api/bot-analytics", or narrow `isProPath`, and the peer corpus becomes free
// with no error anywhere and no test red. The bot-triage-entitlement.test.ts lesson, applied to a
// gate that lives in a different repository from the route it protects.
//
// It pins BOTH directions, and the second is the one that catches the more likely mistake: a
// blanket "402 anything under /api" would take out the free routes beside it.
//
// ── THE HARNESS ─────────────────────────────────────────────────────────────────────────────────
// `registerAuthGate` reads only `req.account` and the path — it does NOT consult `config.isCloud`
// (app.ts decides that by registering it only in cloud). So the gate is exercised faithfully by
// seating `req.account` from a hook registered AHEAD of it, which also lets one app instance play
// all four accounts: unauthenticated, free cloud, paid cloud, and the synthesized local one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DEPLOYMENT_MODE = 'local';
process.env.DATABASE_URL = '/tmp/pierre-pro-benchmark-entitlement-test.sqlite';
process.env.DISABLE_SCHEDULER = 'true';
process.env.RATE_LIMIT_DISABLED = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;

/** Swapped per test; `null` is an unauthenticated cloud request. */
let account: any = null;

const cloudAccount = (plan: string): any => ({
  id: 7,
  githubUserId: '1',
  githubLogin: 'octo',
  displayName: null,
  avatarUrl: null,
  isLocal: false,
  plan,
  stripeCustomerId: null,
  aiCreditAllowance: null,
  benchmarkOptIn: false,
});

/** The synthesized single-tenant account a `pnpm dev` / `npx pierre-review` run always has. */
const LOCAL_ACCOUNT = { ...cloudAccount('free'), id: 1, isLocal: true };

/** Every plugin route this file cares about, plus a CORE route that must never be swept in. */
const PRO_ROUTES = ['/api/pro/bot-benchmark', '/api/pro/bot-behaviour'] as const;
const FREE_ROUTE = '/api/bot-reviewers';

async function get(url: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  const { registerAuthGate } = await import('./auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', async (req: any) => {
    req.account = account;
  });
  registerAuthGate(app);
  for (const url of [...PRO_ROUTES, FREE_ROUTE]) {
    app.get(url, async () => ({ ok: true }));
  }
  // The benchmark route also answers a selector; the gate must fire before any of it is parsed.
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('GET /api/pro/bot-benchmark rides the automatic /api/pro/* paywall', () => {
  it('402s a free-plan cloud account', async () => {
    account = cloudAccount('free');
    const res = await get('/api/pro/bot-benchmark');
    expect(res.status).toBe(402);
    // The SAME body every other paid route sends, so a client cannot tell the benchmark from a
    // core paid route by its refusal.
    expect(res.body).toEqual({ error: 'pro required' });
  });

  it('402s BEFORE the ?cells= selector is parsed — no 400/402 oracle', async () => {
    // An over-cap or malformed selector is a 400 once entitled. Unentitled it must still be 402,
    // or the status code tells an unentitled caller which selectors the route understands and,
    // through the cap, roughly how big the corpus is.
    account = cloudAccount('free');
    for (const q of ['?cells=coderabbit:1', '?cells=not a cell', `?cells=${'x:1,'.repeat(40)}`]) {
      const res = await get(`/api/pro/bot-benchmark${q}`);
      expect(res.status, q).toBe(402);
      expect(res.body, q).toEqual({ error: 'pro required' });
    }
  });

  it('200s a paid cloud account — the OTHER direction', async () => {
    // Without this half the gate could be `return reply.code(402)` unconditionally and still pass
    // every assertion above.
    account = cloudAccount('pro');
    expect((await get('/api/pro/bot-benchmark')).status).toBe(200);
  });

  it('200s the synthesized local account — `npx pierre-review` is never paywalled here', async () => {
    account = LOCAL_ACCOUNT;
    expect((await get('/api/pro/bot-benchmark')).status).toBe(200);
  });

  it('401s an unauthenticated cloud request, ahead of the 402', async () => {
    account = null;
    const res = await get('/api/pro/bot-benchmark');
    expect(res.status).toBe(401);
  });

  it('gates the benchmark exactly as its /api/pro/ siblings are gated', async () => {
    // The benchmark's entitlement is "it is under /api/pro/", nothing more. If it ever diverges
    // from bot-behaviour here, something has special-cased one of them.
    account = cloudAccount('free');
    for (const url of PRO_ROUTES) expect((await get(url)).status, url).toBe(402);
    account = cloudAccount('pro');
    for (const url of PRO_ROUTES) expect((await get(url)).status, url).toBe(200);
  });

  it('leaves the free bot routes free — this half catches OVER-gating', async () => {
    account = cloudAccount('free');
    expect((await get(FREE_ROUTE)).status).toBe(200);
  });
});
