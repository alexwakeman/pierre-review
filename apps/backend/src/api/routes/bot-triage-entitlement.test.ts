// THE TIER LINE, PINNED IN BOTH DIRECTIONS — on a THROWAWAY sqlite DB with a real Fastify instance
// (the billing.test.ts / bot-triage-window.test.ts pattern).
//
// ⚠ WHY THIS FILE EXISTS. Seven entitlement gates were added across `bot-triage.ts` and `flow.ts`,
// and before this file NOTHING pinned any of them: deleting the four lines at the top of
// `flow.ts`'s handler left the whole backend suite green, and Chronology silently went free again.
// A monetisation gate that no test asserts is a gate that comes back off in a refactor.
//
// It pins BOTH directions on purpose, and the SECOND direction is the one that catches the more
// likely mistake. Over-gating is as much a defect as under-gating here: three surfaces on the Bots
// rail are deliberately free (the bot-only governance caution, the tuning-suggestions box, the
// whole classification screen), and each of them reads a route that a "finish the job" pass would
// find sitting suspiciously ungated beside its 402'ing siblings.
//
// ── THE HARNESS NEEDS TWO THINGS, AND THE SECOND IS THE ONE PEOPLE MISS ─────────────────────────
//   1. `registerAccountContext` — without it `req.account` is undefined and every gate fails closed,
//      so the file could only ever exercise the 402 branch.
//   2. `setProCapabilities(...)` — `entitledProCapabilities` INTERSECTS the account with the LOADED
//      PLUGIN's live capability singleton, which is `EMPTY_CAPABILITIES` in any process that never
//      bound a plugin. So even the synthesized `isLocal` account (which short-circuits the plan
//      check) is legitimately unentitled until the singleton is seeded.
// Because the singleton is module-global and mutable, "unentitled" and "entitled" are the same app
// with a different `setProCapabilities` call — which is exactly the live entitlement flip the client
// hooks have to survive, so it is the right shape to test.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-triage-entitlement-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let closeDb: (() => Promise<void> | void) | undefined;
let setProCapabilities: (c: any) => void;
let EMPTY: any;

const FROM = Date.UTC(2026, 6, 1);
const TO = Date.UTC(2026, 6, 15);

/** Every member true — the pro/contract.test.ts literal. Spelled in full so a NEW capability is a
 *  tsc error here rather than a silently-false flag. */
const FULL = {
  activityDigest: true,
  reviewMemory: true,
  aiAnalysis: true,
  prSummary: true,
  aiFix: true,
  workspaceInsights: true,
  claudeReview: true,
  slackDigest: true,
  issueLinks: true,
  botTriage: true,
  botAdvisor: true,
  periodReports: true,
  botDepth: true,
  workPlan: true,
};

/** Entitled to Reports but NOT to bot depth — the account the union predicate exists for. This is
 *  the only witness for `botDepth || periodReports`; with `FULL` alone, a gate mistakenly narrowed
 *  to `botDepth` would still pass every assertion in this file. */
const REPORTS_ONLY = { ...FULL, botDepth: false };

/** Entitled to bot depth but NOT to Reports — the mirror witness, so a gate mistakenly narrowed to
 *  `periodReports` is caught too. */
const DEPTH_ONLY = { ...FULL, periodReports: false };

async function get(url: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

/** The six routes whose ENTIRE population is the paid ROI panel — a 402 is the whole gate, because
 *  there is no free half to narrow for. `…/vendor/:key/prs` reproduces one row of the paid table;
 *  the three `/volume` routes feed its "Comments/PR" column and the gated scatter; `/flagging`
 *  backs the ML strip tiles. `PUT …/cost` is covered separately (it is a write). */
const BOT_DEPTH_ONLY_ROUTES: readonly string[] = [
  '/api/bot-analytics/volume?window=rolling_14',
  '/api/bot-analytics/volume/prs?window=rolling_14',
  '/api/bot-analytics/volume/scatter?window=rolling_14',
  '/api/bot-analytics/flagging?select=findings',
  '/api/bot-analytics/vendor/u999/prs?window=rolling_14',
];

/** The routes the ROI panel SHARES with the People report's bot sections, and which therefore take
 *  the UNION. `/api/bot-analytics` is deliberately absent: it narrows rather than refusing. */
const UNION_ROUTES: readonly string[] = [
  '/api/bot-analytics/vendor/u999/comments?window=rolling_14',
  `/api/bot-authoring?userId=999&fromMs=${FROM}&toMs=${TO}`,
];

/** Routes that MUST stay 200 on a completely unentitled account. Each one is the data behind a
 *  surface that is free by decision, not by omission. */
const FREE_ROUTES: readonly string[] = [
  // The identity/colour backbone for the whole SPA, and the free classification screen.
  '/api/bot-reviewers',
  // The list behind the free amber "only a bot reviewed these" caution — its caption and its list
  // must agree, and the caption lives outside the paid panel.
  '/api/bot-analytics/bot-only-prs?window=rolling_14',
  // Narrows rather than refuses: the same response feeds two free surfaces in BotsView.
  '/api/bot-analytics?window=rolling_14',
];

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();

  const contract = await import('../../pro/contract.js');
  setProCapabilities = contract.setProCapabilities;
  EMPTY = contract.EMPTY_CAPABILITIES;

  const botTriage = await import('./bot-triage.js');
  const flow = await import('./flow.js');
  const { registerAccountContext } = await import('../plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(botTriage.botTriageRoutes);
  await app.register(flow.flowRoutes);
  await app.ready();
});

afterAll(async () => {
  setProCapabilities?.(EMPTY);
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('Chronology — GET /api/flow-findings gates on periodReports', () => {
  it('402s with the plugin-absent capability set', async () => {
    setProCapabilities(EMPTY);
    const res = await get('/api/flow-findings');
    expect(res.status).toBe(402);
    // The SAME body the /api/pro/* blanket gate sends, so a client cannot tell a core paid route
    // from a plugin one.
    expect(res.body).toEqual({ error: 'pro required' });
  });

  it('402s identically for every ?workspace= value — never an existence oracle', async () => {
    setProCapabilities(EMPTY);
    // A real id, a foreign id and garbage must be indistinguishable: the gate sits AHEAD of
    // resolveWorkspaceScope precisely so an unentitled caller learns nothing about which
    // workspaces exist (and does no DB work).
    const a = await get('/api/flow-findings?workspace=1');
    const b = await get('/api/flow-findings?workspace=987654');
    const c = await get('/api/flow-findings?workspace=not-a-number');
    for (const r of [a, b, c]) {
      expect(r.status).toBe(402);
      expect(r.body).toEqual({ error: 'pro required' });
    }
  });

  it('200s with periodReports alone — it does NOT ride botDepth', async () => {
    setProCapabilities(REPORTS_ONLY);
    const res = await get('/api/flow-findings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('workspaceId');
  });

  it('402s with botDepth alone — the flag is periodReports, not "any paid flag"', async () => {
    setProCapabilities(DEPTH_ONLY);
    expect((await get('/api/flow-findings')).status).toBe(402);
  });
});

describe('The Bots ROI routes gate on botDepth', () => {
  it('402s every ROI-only route with no capabilities', async () => {
    setProCapabilities(EMPTY);
    for (const url of BOT_DEPTH_ONLY_ROUTES) {
      const res = await get(url);
      expect(res.status, url).toBe(402);
      expect(res.body, url).toEqual({ error: 'pro required' });
    }
  });

  it('402s them for a Reports-only account — the union does NOT reach these', async () => {
    // The mirror of the union test below: these five have exactly one paid owner, so widening them
    // to `botDepth || periodReports` would hand the whole ROI table to a Reports subscriber.
    setProCapabilities(REPORTS_ONLY);
    for (const url of BOT_DEPTH_ONLY_ROUTES) {
      expect((await get(url)).status, url).toBe(402);
    }
  });

  it('200s them with botDepth', async () => {
    setProCapabilities(FULL);
    for (const url of BOT_DEPTH_ONLY_ROUTES) {
      expect((await get(url)).status, url).toBe(200);
    }
  });

  it('gates the flagging drill-down ABOVE its selector parsing (no 400/402 oracle)', async () => {
    // An invalid `select` would 400 if the schema ran first. Unentitled, it must 402 — otherwise
    // the status code tells an unentitled caller which selectors the route knows about.
    setProCapabilities(EMPTY);
    expect((await get('/api/bot-analytics/flagging?select=findings')).status).toBe(402);
  });

  it('402s PUT /api/bot-reviewers/:userId/cost — the price WRITE', async () => {
    setProCapabilities(EMPTY);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/bot-reviewers/999/cost',
      payload: { workspaceId: 1, monthlyUsd: 240 },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: 'pro required' });
  });
});

describe('The two shared routes take the UNION botDepth || periodReports', () => {
  it('402s them with no capabilities', async () => {
    setProCapabilities(EMPTY);
    for (const url of UNION_ROUTES) {
      const res = await get(url);
      expect(res.status, url).toBe(402);
      expect(res.body, url).toEqual({ error: 'pro required' });
    }
  });

  it('200s them with periodReports ALONE — the only witness for the union', async () => {
    // ⚠ THIS IS THE ASSERTION THE UNION EXISTS FOR. Both routes back the People report's per-bot
    // evidence: `…/comments` its evidence cards, `/api/bot-authoring` its authoring vector. Gated
    // on `botDepth` alone, a Reports customer opens a report they paid for with every bot section
    // blank and nothing on screen explaining why.
    setProCapabilities(REPORTS_ONLY);
    for (const url of UNION_ROUTES) {
      expect((await get(url)).status, url).toBe(200);
    }
  });

  it('200s them with botDepth ALONE — the other half of the union', async () => {
    setProCapabilities(DEPTH_ONLY);
    for (const url of UNION_ROUTES) {
      expect((await get(url)).status, url).toBe(200);
    }
  });

  it('/api/bot-authoring is gated ABOVE parseWindowBounds (no 400/402 oracle)', async () => {
    // Bounds are REQUIRED on this route, so a missing pair 400s at the ajv layer once entitled.
    // Unentitled with VALID bounds it must 402 — the gate is the first statement in the handler.
    setProCapabilities(EMPTY);
    expect(
      (await get(`/api/bot-authoring?userId=999&fromMs=${TO}&toMs=${FROM}`)).status,
    ).toBe(402);
  });
});

describe('The free surfaces stay free — this half catches OVER-gating', () => {
  it('200s every deliberately-free route with no capabilities at all', async () => {
    setProCapabilities(EMPTY);
    for (const url of FREE_ROUTES) {
      const res = await get(url);
      expect(res.status, url).toBe(200);
    }
  });

  it('keeps the free governance half of /api/bot-analytics and withholds the ROI half', async () => {
    setProCapabilities(EMPTY);
    const { status, body } = await get('/api/bot-analytics?window=rolling_14');
    expect(status).toBe(200);
    // ⚠ THE FREE HALF. `totals.botOnlyPrs` is the amber "only a bot reviewed N open PRs" caution
    // that lives in BotsView OUTSIDE the panel, and `suggestions` is the hoisted tuning box. A
    // blanket 402 here would delete both with NO error anywhere (the client reads `?? 0` / `?? []`)
    // — which is exactly why this route narrows instead of refusing.
    expect(typeof body.totals.botOnlyPrs).toBe('number');
    expect(typeof body.totals.overdueGraceMs).toBe('number');
    expect(Array.isArray(body.suggestions)).toBe(true);
    // ⚠ THE PAID HALF, WITHHELD. `vendors` is REQUIRED on the wire so it comes back empty rather
    // than absent; `ml`/`qualityChecks` are optional, so they take the honest absence.
    expect(body.vendors).toEqual([]);
    expect(body.ml).toBeUndefined();
    expect(body.qualityChecks).toBeUndefined();
    // The ROI half of `totals` is zeroed, and `actedOnPct` takes the honest null rather than 0%.
    expect(body.totals.threads).toBe(0);
    expect(body.totals.actedOnPct).toBeNull();
  });

  it('strips the seat PRICE from the reviewer listing without botDepth', async () => {
    setProCapabilities(EMPTY);
    const { status, body } = await get('/api/bot-reviewers');
    expect(status).toBe(200);
    // The route cannot 402 — it is the app-wide bot identity/colour backbone — so the row survives
    // with the money removed, in exactly the shape a never-priced row has.
    for (const r of body.reviewers) {
      expect(r.costMonthlyUsd).toBeNull();
      expect(r.effectiveMonthlyUsd).toBeNull();
      expect(r.costModel).toBe('flat');
    }
    // `workspaceSeatCount` SURVIVES: a derived headcount is not money.
    expect(body).toHaveProperty('workspaceSeatCount');
  });

  it('still answers the reviewer listing and the bot-only list with botDepth on', async () => {
    // The free routes must not have been made CONDITIONALLY free — entitled is still 200.
    setProCapabilities(FULL);
    for (const url of FREE_ROUTES) {
      expect((await get(url)).status, url).toBe(200);
    }
  });
});
