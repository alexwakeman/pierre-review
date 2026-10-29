// NOTION DOCUMENTS AND FIGURES end to end over the REAL core client (a scratch SQLite), a scratch docs
// folder, an in-memory wiki registered as the NOTION adapter (fake-wiki.ts — a body's `{{figure:N}}` is
// an image), a FAKE build agent and a FAKE vision call. No real Notion call, no model. Pinned:
//   1. Notion credentials: a token of the wrong shape is refused; a saved one is write-only; the check
//      route reads Notion with it; without one, adding a Notion page is refused.
//   2. Import: a Notion page tree becomes ONE document; its image is described ONCE, labelled as AI.
//   3. A refresh that changes another page describes NOTHING again (the cache, keyed by the image).
//   4. A failed description leaves the image pending; the cheap check then says "changed" and the next
//      refresh describes it.
//   5. Codex (no vision): names kept, one sentence in the build info.
//   6. An AUTOMATIC refresh over the AI budget makes no vision call and commits nothing.
//   7. Erasure removes the account's description cache.
//
//   DATABASE_URL=<scratch> pnpm --filter @pierre-review/backend test notion-figures-db
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { fakeWiki, type FakeWiki } from './fake-wiki.js';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-notiondocs'}.notion-figures-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const agentCalls: Array<{ expected: string[] }> = [];
vi.mock('../agent.js', async () => {
  const judge = await import('../build-judge.js');
  return {
    DOCS_MODEL: 'claude-sonnet-5',
    runBuildAgent: async (args: { mode: 'sections' | 'pdf'; expected: string[] }) => {
      agentCalls.push({ expected: [...args.expected] });
      const state = judge.newBuildState(args.mode, args.expected);
      judge.judgeRecord(state, { sections: args.expected.map((file) => ({ file, summary: `Summary of ${file}` })) }, []);
      const f = judge.judgeFinish(state, { summary: 'The payments handbook.', topics: ['payments'] }, []);
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
let store: typeof import('../store.js');
let refresh: typeof import('./refresh.js');
let describer: typeof import('../figure-describer.js');
let client: typeof import('../../db/client.js');
let wiki: FakeWiki;
let budgetAllows = true;
let ctx: any;
const vision: string[] = [];
let visionFails = false;

const R = '0a000000-0000-4000-8000-000000000001';
const C = '0a000000-0000-4000-8000-000000000002';
const URL_ROOT = 'https://www.notion.so/acme/Payments-handbook-0a000000000040008000000000000001';
const TOKEN = `ntn_${'ab12'}cdefABCDEF0123456789abcdefABCDEF00`;
const T0 = new Date('2026-10-01T00:00:00Z');
const as = (acct: number) => ({ 'x-acct': String(acct) });
const words = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `${topic} rule ${i}: this is how the payments team handles ${topic} every day.`).join('\n\n');

async function waitIdle(acct: number, id: number): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const row = await store.getDocRow(acct, id);
    if (row && (row.status === 'ready' || row.status === 'failed')) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('build did not finish');
}

function libraryText(slug: string): string {
  const dir = join(docsDir, '1', String(wsA), 'library', slug, 'sections');
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

const fakeVision = async (img: { name: string }) => {
  vision.push(img.name);
  if (visionFails) throw new Error('offline');
  return { text: 'A flow chart: Request → Approve → Pay.' };
};

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  docsDir = mkdtempSync(join(tmpdir(), 'limn-notiondocs-'));
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
  await q.ensureDefaultWorkspace(2);
  store = await import('../store.js');
  refresh = await import('./refresh.js');
  describer = await import('../figure-describer.js');
  describer._setFigureDescriberForTest({ describe: fakeVision, note: null });
  const source = await import('./source.js');
  wiki = fakeWiki(
    [
      { id: R, title: 'Payments handbook', parentId: null, version: 1, editedAt: T0, body: `How refunds flow.\n\n{{figure:1}}\n\n${words('intro', 40)}` },
      { id: C, title: 'Disputes', parentId: R, version: 1, editedAt: T0, body: words('disputes', 120), position: 1 },
    ],
    'notion',
  );
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
  describer?._setFigureDescriberForTest(null);
  refresh?._bindWikiRefreshForTest(null);
  await app?.close();
  await closeDb?.();
  rmSync(docsDir, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(() => {
  budgetAllows = true;
  visionFails = false;
});

let docId = 0;

describe('Notion credentials', () => {
  it('without a token, adding a Notion page is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/docs/wiki', headers: as(1), payload: { url: URL_ROOT, childDepth: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'NoWikiCredential', message: expect.stringMatching(/Add a Notion token/) });
  });

  it('a token of the wrong shape is refused; a saved one is write-only; the check reads Notion with it', async () => {
    const bad = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/wiki-credentials`, headers: as(1), payload: { notion: { token: 'https://www.notion.so/x' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/ntn_/);
    const put = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/wiki-credentials`, headers: as(1), payload: { notion: { token: TOKEN } } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(TOKEN);
    expect(put.json().notion).toEqual({ hasToken: true });
    // Confluence is untouched by a Notion save.
    expect(put.json().confluence).toMatchObject({ hasToken: false });
    wiki.resetCalls();
    const check = (await app.inject({ method: 'POST', url: `/api/workspaces/${wsA}/wiki-credentials/check`, headers: as(1), payload: { provider: 'notion' } })).json();
    expect(check).toEqual({ ok: true, message: 'Connected to Notion.' });
    expect(wiki.calls.access).toBe(1);
    const { resolveWikiCredential } = await import('./credentials.js');
    expect(await resolveWikiCredential(1, wsA, { provider: 'notion', host: 'www.notion.so' }, {})).toMatchObject({ state: 'ok', credential: { email: null, token: TOKEN } });
    expect((await resolveWikiCredential(2, wsA, { provider: 'notion', host: 'www.notion.so' }, {})).state).toBe('none');
  });
});

describe('a Notion document with a figure', () => {
  it('imports the page tree as one document and describes its image once, labelled as AI', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/docs/wiki', headers: as(1), payload: { url: URL_ROOT, childDepth: 1 } });
    expect(res.statusCode).toBe(202);
    docId = res.json().doc.id;
    expect(res.json().doc.wiki).toMatchObject({ provider: 'notion', site: 'www.notion.so', rootPageId: R });
    const row = await waitIdle(1, docId);
    expect(row.status).toBe('ready');
    expect(vision).toEqual(['figure-1.png']);
    const text = libraryText(row.slug);
    expect(text).toContain('[Figure (described by AI): figure-1.png — A flow chart: Request → Approve → Pay.]');
    expect(text).not.toContain('limn-figure');
    expect(store.toReferenceDoc(row).figures).toEqual({ described: 1, outlined: 0, kept: 0, pending: 0, note: null });
    expect(readdirSync(join(docsDir, '1', String(wsA), 'sources', row.slug, 'figures'))).toHaveLength(1);
  });

  it('a refresh that changes another page makes NO vision call (the cache)', async () => {
    wiki.edit(C, `${words('disputes', 120)}\n\nNew: disputes over 500 EUR go to legal.`);
    await app.inject({ method: 'POST', url: `/api/docs/${docId}/refresh`, headers: as(1) });
    const row = await waitIdle(1, docId);
    expect(row.status).toBe('ready');
    expect(vision).toEqual(['figure-1.png']);
    expect(libraryText(row.slug)).toContain('[Figure (described by AI): figure-1.png');
    expect(libraryText(row.slug)).toContain('go to legal');
  });

  it('a failed description waits; the cheap check then finds it and the next refresh describes it', async () => {
    visionFails = true;
    wiki.edit(R, `How refunds flow.\n\n{{figure:1}}\n\nAnd the new one:\n\n{{figure:2}}\n\n${words('intro', 40)}`);
    await app.inject({ method: 'POST', url: `/api/docs/${docId}/refresh`, headers: as(1) });
    let row = await waitIdle(1, docId);
    expect(row.status).toBe('ready');
    expect(vision.slice(-1)).toEqual(['figure-2.png']);
    expect(store.toReferenceDoc(row).figures).toMatchObject({ described: 1, pending: 1 });
    expect(libraryText(row.slug)).toContain('[Image: figure-2.png]');
    // Nothing changed in Notion, but a figure waits: the check says "changed".
    visionFails = false;
    refresh._bindWikiRefreshForTest(ctx);
    expect(await refresh.checkAndMaybeRefresh(ctx, row, true)).toBe('changed');
    row = await waitIdle(1, docId);
    expect(vision.slice(-1)).toEqual(['figure-2.png']);
    expect(store.toReferenceDoc(row).figures).toMatchObject({ described: 2, pending: 0 });
    expect(libraryText(row.slug)).toContain('[Figure (described by AI): figure-2.png');
    expect(await refresh.checkAndMaybeRefresh(ctx, row, true)).toBe('unchanged');
  });

  it('an AUTOMATIC refresh over the AI budget makes no vision call and commits nothing', async () => {
    const calls = vision.length;
    budgetAllows = false;
    wiki.edit(C, `${words('disputes', 120)}\n\n{{figure:3}}`, new Date());
    const before = (await store.getDocRow(1, docId))!;
    expect(await refresh.checkAndMaybeRefresh(ctx, before, true)).toBe('changed');
    const row = await waitIdle(1, docId);
    expect(row.status).toBe('ready');
    expect(vision.length).toBe(calls);
    expect(row.builtAt.getTime()).toBe(before.builtAt!.getTime());
  });

  it('on Codex the images keep their names and the build says so once', async () => {
    describer._setFigureDescriberForTest({ describe: null, note: describer.NOTE_CODEX });
    try {
      await app.inject({ method: 'POST', url: `/api/docs/${docId}/rebuild`, headers: as(1) });
      const row = await waitIdle(1, docId);
      expect(row.status).toBe('ready');
      const doc = store.toReferenceDoc(row);
      expect(doc.figures?.note).toBe('Images keep their names: Codex does not read images.');
      expect(libraryText(row.slug)).toContain('[Image: figure-3.png]');
    } finally {
      describer._setFigureDescriberForTest({ describe: fakeVision, note: null });
    }
  });

  it('erasure removes the description cache', async () => {
    const t = client.schema.referenceDocFigureDescriptions;
    expect((await client.db.select().from(t).execute()).filter((r: any) => r.accountId === 1).length).toBeGreaterThan(0);
    const { eraseAccountData } = await import('../../db/erase-account.js');
    await eraseAccountData(1);
    expect((await client.db.select().from(t).execute()).filter((r: any) => r.accountId === 1)).toEqual([]);
  });
});
