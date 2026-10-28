// WIKI DOCUMENTS end to end over the REAL core client (a scratch SQLite), a scratch docs folder, an
// in-memory wiki (fake-wiki.ts, registered as the Confluence adapter) and a FAKE build agent that
// records what it was asked to summarise. No real Confluence call, no model. Pinned:
//   1. Credentials: none → the add is refused; the token is write-only; a Jira credential on the SAME
//      host is reused, on another host it is not.
//   2. Import: a page tree becomes ONE document (a chapter per page); one row per page.
//   3. Refresh, nothing changed: no page body read, NO model call, the check is stamped.
//   4. Refresh, one page changed: only that page is read and only its sections are summarised (the
//      summary cache); unchanged sections keep their summaries.
//   5. An AUTOMATIC refresh over the budget is SKIPPED: no model call, nothing committed.
//   6. A root that is gone: the last version stays readable and the row says since when.
//   7. The cadence: only libraries used in the last 7 days; the pre-use kick never blocks.
//   8. Tenancy: another account's document / workspace is a 404; removal and erasure take the pages.
//
//   DATABASE_URL=<scratch> pnpm --filter @pierre-review/backend test wiki-db
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { fakeWiki, type FakeWiki } from './fake-wiki.js';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-wikidocs'}.wiki-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const agentCalls: Array<{ expected: string[]; prompt: string }> = [];
vi.mock('../agent.js', async () => {
  const judge = await import('../build-judge.js');
  return {
    DOCS_MODEL: 'claude-sonnet-5',
    runBuildAgent: async (args: { mode: 'sections' | 'pdf'; expected: string[]; prompt: string }) => {
      agentCalls.push({ expected: [...args.expected], prompt: args.prompt });
      const state = judge.newBuildState(args.mode, args.expected);
      judge.judgeRecord(state, { sections: args.expected.map((file) => ({ file, summary: `Summary #${agentCalls.length} of ${file}` })) }, []);
      const f = judge.judgeFinish(state, { summary: `Handbook, build ${agentCalls.length}.`, topics: ['payments'] }, []);
      return { state, finish: 'accepted' in f ? f.accepted : null, aborted: false, costUsd: 0.01, inputTokens: 10, outputTokens: 5, numTurns: 2, provider: 'claude', model: 'claude-sonnet-5' };
    },
    runDocsChatAgent: async () => ({ ok: true, text: 'x', aborted: false, costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 1 }),
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let docsDir: string;
let wsA = 0;
let wsB = 0;
let store: typeof import('../store.js');
let pagesMod: typeof import('./pages.js');
let refresh: typeof import('./refresh.js');
let client: typeof import('../../db/client.js');
let wiki: FakeWiki;
let budgetAllows = true;
let ctx: any;

const T0 = new Date('2026-10-01T00:00:00Z');
const URL_ROOT = 'https://acme.atlassian.net/wiki/spaces/PAY/pages/1/Payments';
const as = (acct: number) => ({ 'x-acct': String(acct) });
const words = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `${topic} rule ${i}: this is how the payments team handles ${topic} every single day.`).join('\n\n');

function seedWiki(): FakeWiki {
  return fakeWiki([
    { id: '1', title: 'Payments handbook', parentId: null, version: 1, editedAt: T0, body: `How the payments team works.\n\n${words('intro', 40)}` },
    { id: '2', title: 'Refunds', parentId: '1', version: 1, editedAt: T0, body: words('refunds', 120), position: 1 },
    { id: '3', title: 'Invoices', parentId: '1', version: 1, editedAt: T0, body: words('invoices', 120), position: 2 },
  ]);
}

async function waitIdle(acct: number, id: number): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const row = await store.getDocRow(acct, id);
    if (row && (row.status === 'ready' || row.status === 'failed')) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('build did not finish');
}

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  docsDir = mkdtempSync(join(tmpdir(), 'limn-wikidocs-'));
  const paths = await import('../paths.js');
  paths.setDocsRootForTest(docsDir);
  const { runMigrations } = await import('../../db/run-migrations.js');
  client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  for (const id of [1, 2]) {
    await client.db.insert(client.schema.accounts).values({ id, githubUserId: `U${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
  }
  const q = await import('../../db/queries.js');
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  store = await import('../store.js');
  pagesMod = await import('./pages.js');
  refresh = await import('./refresh.js');
  const source = await import('./source.js');
  wiki = seedWiki();
  source._setWikiSourceForTest(wiki);
  const { registerReferenceDocsRoutes } = await import('../routes.js');
  const Fastify = (await import('fastify')).default;
  app = Fastify({ logger: false });
  ctx = {
    accountIdOf: (req: any) => Number(req.headers['x-acct'] ?? 1),
    log: { info() {}, warn() {}, error() {} },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    recordAiUsage: async () => {},
    aiBudget: { allowAutomaticRun: async () => budgetAllows },
    registerScheduledJob: () => {},
  };
  registerReferenceDocsRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  refresh?._bindWikiRefreshForTest(null);
  await app?.close();
  await closeDb?.();
  rmSync(docsDir, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(() => {
  budgetAllows = true;
});

const addWiki = (acct = 1, childDepth = 1) =>
  app.inject({ method: 'POST', url: '/api/docs/wiki', headers: as(acct), payload: { url: URL_ROOT, childDepth } });

let docId = 0;

describe('credentials', () => {
  it('without one, adding a page is refused before anything is stored', async () => {
    const res = await addWiki();
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Add a Confluence API token/);
    expect((await store.listDocRows(1, wsA)).length).toBe(0);
  });

  it('a non-page address is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/docs/wiki', headers: as(1), payload: { url: 'https://acme.atlassian.net/wiki/x/AQAB' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NotAWikiPage');
  });

  it('reuses the Jira credential only on the same host', async () => {
    const t = client.schema.workspaceTrackers;
    await client.db.insert(t).values({ accountId: 1, workspaceId: wsA, provider: 'jira', baseUrl: 'https://acme.atlassian.net', authEmail: 'me@acme.test', authToken: 'plain:jira-tok' }).execute();
    const { resolveWikiCredential } = await import('./credentials.js');
    const same = await resolveWikiCredential(1, wsA, { provider: 'confluence', host: 'acme.atlassian.net' }, {});
    expect(same).toEqual({ state: 'ok', credential: { email: 'me@acme.test', token: 'jira-tok' }, from: 'jira' });
    expect((await resolveWikiCredential(1, wsA, { provider: 'confluence', host: 'other.atlassian.net' }, {})).state).toBe('none');
    // Account 2 never reads account 1's Jira row.
    expect((await resolveWikiCredential(2, wsB, { provider: 'confluence', host: 'acme.atlassian.net' }, {})).state).toBe('none');
    const got = (await app.inject({ method: 'GET', url: `/api/workspaces/${wsA}/wiki-credentials`, headers: as(1) })).json();
    expect(got.confluence).toMatchObject({ jiraSite: 'acme.atlassian.net', hasToken: false });
    await client.db.delete(t).execute();
  });

  it('a saved token is write-only', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${wsA}/wiki-credentials`,
      headers: as(1),
      payload: { confluence: { siteUrl: 'https://acme.atlassian.net/wiki/home', email: 'me@acme.test', token: 'conf-secret-token' } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('conf-secret-token');
    expect(put.json().confluence).toMatchObject({ siteUrl: 'https://acme.atlassian.net', email: 'me@acme.test', hasToken: true });
    const bad = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/wiki-credentials`, headers: as(1), payload: { confluence: { siteUrl: 'http://x' } } });
    expect(bad.statusCode).toBe(400);
    // Another account's workspace: 404, and nothing written there.
    const cross = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsB}/wiki-credentials`, headers: as(1), payload: { confluence: { token: 'x' } } });
    expect(cross.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${wsB}/wiki-credentials`, headers: as(1) })).statusCode).toBe(404);
    const check = (await app.inject({ method: 'POST', url: `/api/workspaces/${wsA}/wiki-credentials/check`, headers: as(1) })).json();
    expect(check).toEqual({ ok: true, message: 'Connected to acme.atlassian.net.' });
  });
});

describe('import', () => {
  it('a page tree becomes ONE document, a chapter per page, a row per page', async () => {
    const res = await addWiki();
    expect(res.statusCode).toBe(202);
    docId = res.json().doc.id;
    expect(res.json().doc).toMatchObject({ sourceKind: 'wiki', wiki: { provider: 'confluence', site: 'acme.atlassian.net', rootPageId: '1', depth: 1 } });
    const row = await waitIdle(1, docId);
    expect(row.status).toBe('ready');
    expect(row.title).toBe('Payments handbook');
    expect(agentCalls).toHaveLength(1);
    const pages = await pagesMod.listWikiPages(1, docId);
    expect(pages.map((p) => [p.pageId, p.depth, p.version])).toEqual([
      ['1', 0, 1],
      ['2', 1, 1],
      ['3', 1, 1],
    ]);
    const doc = store.toReferenceDoc(row);
    expect(doc.wiki).toMatchObject({ pageCount: 3, unreachableSince: null });
    expect(doc.wiki?.lastCheckedAt).not.toBeNull();
    const contents = readFileSync(join(docsDir, '1', String(wsA), 'library', row.slug, 'CONTENTS.md'), 'utf8');
    expect(contents).toContain('Refunds');
    expect(contents).toContain('Invoices');
    expect(existsSync(join(docsDir, '1', String(wsA), 'sources', row.slug, 'pages', '2.md'))).toBe(true);
  });
});

describe('refresh', () => {
  it('nothing changed: no page body read and NO model call', async () => {
    wiki.resetCalls();
    const before = (await store.getDocRow(1, docId))!;
    const res = await app.inject({ method: 'POST', url: `/api/docs/${docId}/refresh`, headers: as(1) });
    expect(res.statusCode).toBe(202);
    const row = await waitIdle(1, docId);
    expect(row.status).toBe('ready');
    expect(agentCalls).toHaveLength(1);
    expect(wiki.calls.getBody).toEqual([]);
    expect(row.builtAt?.getTime()).toBe(before.builtAt?.getTime());
  });

  it('one page changed: only it is read, only its sections are summarised', async () => {
    wiki.resetCalls();
    wiki.edit('3', `${words('invoices', 120)}\n\nNew rule: invoices over 10k need a second approver.`);
    const before = (await store.getDocRow(1, docId))!;
    await app.inject({ method: 'POST', url: `/api/docs/${docId}/refresh`, headers: as(1) });
    const row = await waitIdle(1, docId);
    expect(row.status).toBe('ready');
    expect(wiki.calls.getBody).toEqual(['3']);
    expect(agentCalls).toHaveLength(2);
    const call = agentCalls[1]!;
    // Only the changed section(s), never all of them.
    expect(call.expected.length).toBeGreaterThan(0);
    expect(call.expected.length).toBeLessThan(row.sectionCount);
    expect(call.prompt).toContain('NEW OR CHANGED');
    expect(call.expected.every((f) => /invoices/.test(f))).toBe(true);
    // Unchanged sections kept the FIRST build's summaries.
    const kept = (row.sections ?? []).filter((s: any) => !/invoices/.test(s.path));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((s: any) => s.summary.startsWith('Summary #1 '))).toBe(true);
    expect(row.builtAt.getTime()).toBeGreaterThanOrEqual(before.builtAt!.getTime());
    expect((await pagesMod.listWikiPages(1, docId)).find((p) => p.pageId === '3')?.version).toBe(2);
  });

  it('an AUTOMATIC refresh over the budget is skipped: no model call, nothing committed', async () => {
    budgetAllows = false;
    wiki.edit('2', `${words('refunds', 120)}\n\nRefunds over 1k need finance.`, new Date());
    refresh._bindWikiRefreshForTest(ctx);
    const row0 = (await store.getDocRow(1, docId))!;
    expect(await refresh.checkAndMaybeRefresh(ctx, row0, true)).toBe('changed');
    const row = await waitIdle(1, docId);
    expect(row.status).toBe('ready');
    expect(agentCalls).toHaveLength(2);
    expect((await pagesMod.listWikiPages(1, docId)).find((p) => p.pageId === '2')?.version).toBe(1);
    // The budget allows again: the same change is found and built.
    budgetAllows = true;
    expect(await refresh.checkAndMaybeRefresh(ctx, (await store.getDocRow(1, docId))!, true)).toBe('changed');
    await waitIdle(1, docId);
    expect(agentCalls).toHaveLength(3);
    expect((await pagesMod.listWikiPages(1, docId)).find((p) => p.pageId === '2')?.version).toBe(2);
  });

  it('a root that is gone keeps the last version and says since when', async () => {
    wiki.failing.set('1', new (await import('./source.js')).WikiSourceError('not_found', 404));
    const before = (await store.getDocRow(1, docId))!;
    await app.inject({ method: 'POST', url: `/api/docs/${docId}/refresh`, headers: as(1) });
    const row = await waitIdle(1, docId);
    expect(row.status).toBe('ready');
    expect(row.builtAt.getTime()).toBe(before.builtAt!.getTime());
    const doc = store.toReferenceDoc(row);
    expect(doc.available).toBe(true);
    expect(doc.wiki).toMatchObject({ unreachableReason: 'not_found' });
    expect(doc.wiki?.unreachableSince).not.toBeNull();
    expect(readdirSync(join(docsDir, '1', String(wsA), 'library', row.slug, 'sections')).length).toBe(row.sectionCount);
    expect((await pagesMod.listWikiPages(1, docId)).length).toBe(3);
    // The cheap check says the same, and never deletes.
    expect(await refresh.checkAndMaybeRefresh(ctx, row, true)).toBe('unreachable');
    wiki.failing.delete('1');
    expect(await refresh.checkAndMaybeRefresh(ctx, (await store.getDocRow(1, docId))!, true)).toBe('unchanged');
    expect(store.toReferenceDoc((await store.getDocRow(1, docId))!).wiki?.unreachableSince).toBeNull();
  });
});

describe('the cadence', () => {
  it('checks only libraries used in the last 7 days, and only when due', async () => {
    const t = Date.now();
    const w = client.schema.workspaces;
    const { eq } = await import('drizzle-orm');
    await client.db.update(w).set({ docsUsedAt: new Date(t - 8 * 24 * 3600_000) }).where(eq(w.id, wsA)).execute();
    expect(await refresh.runWikiRefreshTick(ctx, () => t)).toBe(0);
    await store.stampDocsUsed(1, wsA, new Date(t));
    // Just checked: not due.
    expect(await refresh.runWikiRefreshTick(ctx, () => t)).toBe(0);
    // Four hours on: due.
    wiki.resetCalls();
    expect(await refresh.runWikiRefreshTick(ctx, () => t + 4 * 3600_000)).toBe(1);
    expect(wiki.calls.getBody).toEqual([]);
  });

  it('a 429 Retry-After holds the background check until then', () => {
    const row: any = { status: 'ready', builtAt: new Date(), wiki: { provider: 'confluence', origin: 'https://a.b', rootPageId: '1', retryAfter: 2_000, lastCheckedAt: 0 } };
    expect(refresh.wikiCheckDue(row, 1_000, 0)).toBe(false);
    expect(refresh.wikiCheckDue(row, 3_000, 0)).toBe(true);
  });
});

describe('tenancy and removal', () => {
  it("another account's document is a 404 on refresh, and its pages are never listed", async () => {
    expect((await app.inject({ method: 'POST', url: `/api/docs/${docId}/refresh`, headers: as(2) })).statusCode).toBe(404);
    expect(await pagesMod.listWikiPages(2, docId)).toEqual([]);
    expect(await pagesMod.deleteWikiPages(2, docId)).toBe(0);
    expect((await pagesMod.listWikiPages(1, docId)).length).toBe(3);
    // A page row naming account 1's document under account 2 is refused by the composite FK.
    let refused = false;
    try {
      await client.db.insert(client.schema.referenceDocWikiPages).values({ accountId: 2, docId, pageId: '99', title: 'x' }).execute();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it('removing the document removes its pages', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/docs/${docId}`, headers: as(1) })).statusCode).toBe(200);
    expect(await pagesMod.listWikiPages(1, docId)).toEqual([]);
  });

  it('erasure removes the pages and the credential', async () => {
    const res = await addWiki();
    const id = res.json().doc.id;
    await waitIdle(1, id);
    expect((await pagesMod.listWikiPages(1, id)).length).toBe(3);
    const { eraseAccountData } = await import('../../db/erase-account.js');
    await eraseAccountData(1);
    const rows = await client.db.select().from(client.schema.referenceDocWikiPages).execute();
    expect(rows.filter((r: any) => r.accountId === 1)).toEqual([]);
    const creds = await client.db.select().from(client.schema.workspaceWikiCredentials).execute();
    expect(creds.filter((r: any) => r.accountId === 1)).toEqual([]);
  });
});
