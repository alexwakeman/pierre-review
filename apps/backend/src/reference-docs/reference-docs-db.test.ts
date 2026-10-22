// THE REFERENCE DOCS LIBRARY over the REAL core client (a scratch SQLite) and a scratch docs folder.
// The agent is a FAKE (vi.mock): it records a summary for every file the server split, the way the
// real one is told to, so the pipeline from upload to INDEX.md runs end to end with no model. Pinned:
//   1. Upload: refusals by name, type and size; a markdown upload builds, and INDEX.md, CONTENTS.md
//      and the section files are what the routes serve.
//   2. Paths: the section route takes only the library grammar (traversal → 400) and only this
//      workspace's documents.
//   3. Tenancy: another account's document id is a 404 everywhere; its workspace is refused by the
//      composite FK; its settings route is a 404.
//   4. The chat: the answer's citations are only links to real files of the library.
//   5. Remove: deletes the files and rewrites INDEX.md. Erasure deletes the account's files.
//
//   DATABASE_URL=<scratch> pnpm --filter @pierre-review/backend test reference-docs-db
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-refdocs'}.refdocs-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

vi.mock('./agent.js', async () => {
  const judge = await import('./build-judge.js');
  return {
    DOCS_MODEL: 'claude-sonnet-5',
    runBuildAgent: async (args: { mode: 'sections' | 'pdf'; expected: string[] }) => {
      const state = judge.newBuildState(args.mode, args.expected);
      judge.judgeRecord(state, { sections: args.expected.map((file) => ({ file, summary: `Summary of ${file}` })) }, []);
      const f = judge.judgeFinish(state, { summary: 'How refunds work.', topics: ['refunds', 'invoices'] }, []);
      return { state, finish: 'accepted' in f ? f.accepted : null, aborted: false, costUsd: 0.01, inputTokens: 10, outputTokens: 5, numTurns: 2 };
    },
    runDocsChatAgent: async () => ({
      ok: true,
      text: 'Refunds take 14 days [Partial refunds](refund-handbook/sections/01-refund-handbook.md#partial-refunds). See also [made up](refund-handbook/sections/99-nope.md) and [outside](../../etc/passwd) and [web](https://example.com).',
      aborted: false,
      costUsd: 0.002,
      inputTokens: 5,
      outputTokens: 5,
      numTurns: 1,
    }),
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let docsDir: string;
let wsA = 0;
let wsB = 0;
let store: typeof import('./store.js');
let usage: any[] = [];

const md = `# Refund handbook

How we pay money back.

## Refunds

${Array.from({ length: 30 }, (_, i) => `Rule ${i}: refunds are paid within fourteen days of the request being approved by billing.`).join('\n\n')}

### Partial refunds

A partial refund needs a manager's approval.

## Invoices

${Array.from({ length: 80 }, (_, i) => `Invoice rule ${i}: invoices are issued on the first working day of each month for the month before.`).join('\n\n')}
`;

const as = (acct: number) => ({ 'x-acct': String(acct) });

async function waitReady(acct: number, id: number): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const row = await store.getDocRow(acct, id);
    if (row && (row.status === 'ready' || row.status === 'failed')) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('build did not finish');
}

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  docsDir = mkdtempSync(join(tmpdir(), 'limn-refdocs-'));
  const paths = await import('./paths.js');
  paths.setDocsRootForTest(docsDir);
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  for (const id of [1, 2]) {
    await client.db.insert(client.schema.accounts).values({ id, githubUserId: `U${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
  }
  const q = await import('../db/queries.js');
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  store = await import('./store.js');
  const { registerReferenceDocsRoutes } = await import('./routes.js');
  const Fastify = (await import('fastify')).default;
  app = Fastify({ logger: false });
  registerReferenceDocsRoutes(app, {
    accountIdOf: (req: any) => Number(req.headers['x-acct'] ?? 1),
    log: { info() {}, warn() {}, error() {} },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    recordAiUsage: async (row: any) => {
      usage.push(row);
    },
  } as any);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  rmSync(docsDir, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

const upload = (body: Buffer, name: string | null, acct = 1, ws?: number) =>
  app.inject({
    method: 'POST',
    url: `/api/docs/upload${ws ? `?workspace=${ws}` : ''}`,
    headers: { ...as(acct), 'content-type': 'application/octet-stream', ...(name ? { 'x-limn-filename': encodeURIComponent(name) } : {}) },
    payload: body,
  });

describe('upload', () => {
  it('refuses a missing name, an unreadable type and an oversize file', async () => {
    expect((await upload(Buffer.from('x'), null)).statusCode).toBe(400);
    const png = await upload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), 'a.md');
    expect(png.statusCode).toBe(415);
    expect(png.json().message).toMatch(/not supported/);
    const doc = await upload(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1]), 'old.doc');
    expect(doc.json().message).toMatch(/Save it as \.docx/);
    const big = await upload(Buffer.alloc(25 * 1024 * 1024 + 1, 0x61), 'big.txt');
    expect(big.statusCode).toBe(413);
    const json = await app.inject({ method: 'POST', url: '/api/docs/upload', headers: { 'content-type': 'application/json', 'x-limn-filename': 'a.md' }, payload: '{"a":1}' });
    expect(json.statusCode).toBe(415);
    expect((await store.listDocRows(1, wsA)).length).toBe(0);
  });

  it('builds a markdown upload into the three levels', async () => {
    const res = await upload(Buffer.from(md), 'refund handbook.md');
    expect(res.statusCode).toBe(202);
    const { doc } = res.json();
    expect(doc).toMatchObject({ slug: 'refund-handbook', sourceKind: 'markdown', status: 'queued', workspaceId: wsA });
    const row = await waitReady(1, doc.id);
    expect(row.status).toBe('ready');
    expect(row.title).toBe('Refund handbook');
    expect(row.summary).toBe('How refunds work.');
    expect(row.sectionCount).toBeGreaterThanOrEqual(2);
    expect(usage.some((u) => u.feature === 'reference_docs_build' && u.accountId === 1)).toBe(true);

    const lib = join(docsDir, '1', String(wsA), 'library');
    const index = readFileSync(join(lib, 'INDEX.md'), 'utf8');
    expect(index).toContain('## [Refund handbook](refund-handbook/CONTENTS.md)');
    expect(index).toContain('Topics: refunds, invoices');
    const files = readdirSync(join(lib, 'refund-handbook', 'sections'));
    expect(files.length).toBe(row.sectionCount);
    expect(readdirSync(join(docsDir, '1', String(wsA), 'staging'))).toEqual([]);
    const contents = readFileSync(join(lib, 'refund-handbook', 'CONTENTS.md'), 'utf8');
    expect(contents).toContain('(sections/01-refund-handbook.md#partial-refunds)');
    expect(existsSync(join(docsDir, '1', String(wsA), 'sources', 'refund-handbook'))).toBe(true);

    const list = (await app.inject({ method: 'GET', url: '/api/docs', headers: as(1) })).json();
    expect(list).toMatchObject({ workspaceId: wsA, docsInReview: false });
    expect(list.docs[0]).toMatchObject({ available: true, status: 'ready', progress: 100 });

    const tree = (await app.inject({ method: 'GET', url: `/api/docs/tree?doc=${doc.id}`, headers: as(1) })).json();
    expect(tree.index).toBe(index);
    expect(tree.contents).toContain('# Refund handbook');
    expect(tree.sections[0].path).toMatch(/^refund-handbook\/sections\/\d{2}-/);

    const first = tree.sections[0].path as string;
    const sec = (await app.inject({ method: 'GET', url: `/api/docs/section?path=${encodeURIComponent(first)}`, headers: as(1) })).json();
    expect(sec).toMatchObject({ docSlug: 'refund-handbook', prev: null, next: tree.sections[1]?.path ?? null });
    expect(sec.markdown).toContain('[Contents](../CONTENTS.md)');
  });

  it('a second upload of the same name gets its own slug', async () => {
    const res = await upload(Buffer.from('# Other\n\ntext'), 'refund handbook.md');
    const { doc } = res.json();
    expect(doc.slug).toBe('refund-handbook-2');
    await waitReady(1, doc.id);
    const del = await app.inject({ method: 'DELETE', url: `/api/docs/${doc.id}`, headers: as(1) });
    expect(del.statusCode).toBe(200);
    const lib = join(docsDir, '1', String(wsA), 'library');
    expect(existsSync(join(lib, 'refund-handbook-2'))).toBe(false);
    expect(readFileSync(join(lib, 'INDEX.md'), 'utf8')).not.toContain('refund-handbook-2');
  });
});

describe('a web page with "Follow links"', () => {
  it('stores the crawl depth and the page cap, and refuses a depth past the limit', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/docs/url', headers: as(1), payload: { url: 'https://docs.example.invalid/guide', crawl: { depth: 4 } } });
    expect(bad.statusCode).toBe(400);
    // `.invalid` never resolves, so the build fails at once without touching a network.
    const res = await app.inject({ method: 'POST', url: '/api/docs/url', headers: as(1), payload: { url: 'https://docs.example.invalid/guide', crawl: { depth: 2 } } });
    expect(res.statusCode).toBe(202);
    const doc = res.json().doc;
    expect(doc.crawl).toEqual({ depth: 2, maxPages: 25, pages: null, skipped: null });
    const row = await waitReady(1, doc.id);
    expect(row.status).toBe('failed');
    expect(store.toReferenceDoc(row).crawl?.depth).toBe(2);
    const single = await app.inject({ method: 'POST', url: '/api/docs/url', headers: as(1), payload: { url: 'https://docs.example.invalid/one' } });
    expect(single.json().doc.crawl).toBeNull();
    await waitReady(1, single.json().doc.id);
    for (const id of [doc.id, single.json().doc.id]) await app.inject({ method: 'DELETE', url: `/api/docs/${id}`, headers: as(1) });
  });
});

describe('library paths', () => {
  it.each(['../INDEX.md', 'refund-handbook/../../x/CONTENTS.md', '/etc/passwd', 'refund-handbook/sections/..%2f..%2fx.md'])(
    'refuses %s',
    async (p) => {
      const res = await app.inject({ method: 'GET', url: `/api/docs/section?path=${encodeURIComponent(p)}`, headers: as(1) });
      expect(res.statusCode).toBe(400);
    },
  );

  it("serves only this workspace's documents", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs/section?path=refund-handbook/CONTENTS.md', headers: as(2) });
    expect(res.statusCode).toBe(404);
  });
});

describe('tenancy', () => {
  it("another account's document id is a 404 on every route", async () => {
    const [a] = await store.listDocRows(1, wsA);
    for (const [method, url] of [
      ['POST', `/api/docs/${a!.id}/rebuild`],
      ['POST', `/api/docs/${a!.id}/cancel`],
      ['DELETE', `/api/docs/${a!.id}`],
      ['GET', `/api/docs/${a!.id}/stream`],
      ['GET', `/api/docs/tree?doc=${a!.id}`],
    ] as const) {
      expect((await app.inject({ method, url, headers: as(2) })).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await store.getDocRow(1, a!.id))?.status).toBe('ready');
  });

  it("a row naming another account's workspace is refused by the composite FK", async () => {
    await expect(
      store.insertDocRow({ accountId: 1, workspaceId: wsB, slug: 'x', title: 'x', sourceKind: 'text', sourceName: 'x', sourceUrl: null, byteSize: 1, pageCount: null }),
    ).rejects.toThrow();
  });

  it("an unknown or foreign ?workspace= reads the caller's default, never the other account's", async () => {
    const res = (await app.inject({ method: 'GET', url: `/api/docs?workspace=${wsA}`, headers: as(2) })).json();
    expect(res.workspaceId).toBe(wsB);
    expect(res.docs).toEqual([]);
  });

  it('the settings route is the owner’s only, and off by default', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${wsA}/docs-settings`, headers: as(2) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/docs-settings`, headers: as(2), payload: { docsInReview: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${wsA}/docs-settings`, headers: as(1) })).json()).toEqual({ workspaceId: wsA, docsInReview: false });
    const put = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/docs-settings`, headers: as(1), payload: { docsInReview: true } });
    expect(put.json()).toEqual({ workspaceId: wsA, docsInReview: true });
    const { docsContextFor } = await import('./context.js');
    const c = await docsContextFor(1, wsA);
    expect(c).toMatchObject({ hasDocs: true, docCount: 1, enabledInReview: true, usable: true });
    expect((await docsContextFor(2, wsB)).hasDocs).toBe(false);
  });
});

describe('the chat', () => {
  it('stores the turn and keeps only citations that are real files of the library', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/docs/chat', headers: as(1), payload: { question: 'How long do refunds take?' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversationId).toMatch(/^[a-f0-9]{24}$/);
    expect(body.answer.citations).toEqual([
      {
        path: 'refund-handbook/sections/01-refund-handbook.md',
        anchor: 'partial-refunds',
        docSlug: 'refund-handbook',
        docTitle: 'Refund handbook',
        sectionTitle: 'Refund handbook',
      },
    ]);
    const conv = (await app.inject({ method: 'GET', url: `/api/docs/chats/${body.conversationId}`, headers: as(1) })).json();
    expect(conv.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect((await app.inject({ method: 'GET', url: `/api/docs/chats/${body.conversationId}`, headers: as(2) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/docs/chat', headers: as(2), payload: { question: 'x' } })).statusCode).toBe(409);
  });
});

describe('erasure', () => {
  it("deletes the account's rows and its files", async () => {
    const res = await upload(Buffer.from('# B doc\n\ntext'), 'b.md', 2);
    await waitReady(2, res.json().doc.id);
    expect(existsSync(join(docsDir, '2'))).toBe(true);
    const { eraseAccountData } = await import('../db/erase-account.js');
    await eraseAccountData(2);
    expect(existsSync(join(docsDir, '2'))).toBe(false);
    expect(existsSync(join(docsDir, '1'))).toBe(true);
  });
});
