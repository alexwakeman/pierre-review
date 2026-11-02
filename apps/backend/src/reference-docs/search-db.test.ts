// THE LIBRARY SEARCH over the REAL core client (a scratch SQLite, every migration) and a scratch docs
// folder (docs/REFERENCE-DOCS.md § Search). Pinned:
//   1. Every word must match (AND); a quoted run matches as a phrase; words are stemmed like the index.
//   2. Untrusted text never carries FTS5 syntax (no throw, no widening).
//   3. Tenancy: another account's passages, and another workspace's, are never returned.
//   4. One result per section; only a document's CURRENT build counts.
//   5. The 5% tie rule (a tie goes to the newer document) and the newest sort.
//   6. Pagination: 20 a page, the total, an empty page past the end; `indexed` false for an empty library.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocsSearchResponse, ReferenceDocSectionEntry } from '@pierre-review/shared';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-search`}.search-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

let client: typeof import('../db/client.js');
let store: typeof import('./store.js');
let chunks: typeof import('./chunks.js');
let search: typeof import('./search.js');
let docsDir: string;
let wsA = 0;
let wsA2 = 0;
let wsB = 0;

const sec = (slug: string, n: number, title: string): ReferenceDocSectionEntry => ({
  path: `${slug}/sections/${String(n).padStart(2, '0')}-${title.toLowerCase().replace(/\s+/g, '-')}.md`,
  title,
  summary: '',
  depth: 1,
  trail: ['Part one'],
  headings: [],
  words: 10,
});

/** Insert a built, indexed document (added at `addedAt` unix seconds); returns its id. */
async function doc(acct: number, ws: number, slug: string, title: string, sections: Array<[ReferenceDocSectionEntry, string]>, addedAt = 1_700_000_000): Promise<number> {
  const { libraryDir } = await import('./paths.js');
  const row = await store.insertDocRow({ accountId: acct, workspaceId: ws, slug, title, sourceKind: 'markdown', sourceName: `${slug}.md`, sourceUrl: null, byteSize: 1, pageCount: null });
  for (const [s, body] of sections) {
    const file = join(libraryDir(acct, ws), s.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `<!-- limn reference section 1 of 1 -->\n# ${s.title}\n\n> crumbs\n> nav\n\n${body}\n`);
  }
  await store.saveDocBuilt(acct, row.id, { title, summary: 's', topics: [], sections: sections.map(([s]) => s) }, {});
  client.rawSqlite.prepare('update reference_docs set created_at = ? where id = ?').run(addedAt, row.id);
  await chunks.indexDocChunks(acct, row.id);
  return row.id;
}

const run = (q: string, opts: { acct?: number; ws?: number; sort?: 'relevance' | 'newest'; page?: number } = {}): Promise<DocsSearchResponse> =>
  search.searchDocs({ accountId: opts.acct ?? 1, workspaceId: opts.ws ?? wsA, query: q, sort: opts.sort ?? 'relevance', page: opts.page ?? 1 });
const paths = (r: DocsSearchResponse): string[] => r.results.map((x) => x.path);

let guideId = 0;

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  docsDir = mkdtempSync(join(tmpdir(), 'limn-search-'));
  (await import('./paths.js')).setDocsRootForTest(docsDir);
  const { runMigrations } = await import('../db/run-migrations.js');
  client = await import('../db/client.js');
  await runMigrations();
  for (const id of [1, 2]) {
    await client.db.insert(client.schema.accounts).values({ id, githubUserId: `U${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
  }
  const q = await import('../db/queries.js');
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  const [w2] = await client.db.insert(client.schema.workspaces).values({ accountId: 1, name: 'Second' }).returning({ id: client.schema.workspaces.id }).execute();
  wsA2 = w2!.id;
  store = await import('./store.js');
  chunks = await import('./chunks.js');
  search = await import('./search.js');
});

afterAll(async () => {
  await client?.closeDb();
  rmSync(docsDir, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

describe('the library search', () => {
  it('an empty library is not indexed; empty text finds nothing', async () => {
    const r = await run('hedgerow');
    expect(r.indexed).toBe(false);
    expect(r.total).toBe(0);
  });

  it('every word must match (AND), stemmed, one result per section', async () => {
    guideId = await doc(1, wsA, 'guide', 'Metric guide', [
      [sec('guide', 1, 'Hedgerows'), 'A hedgerow lost on site is replaced by planting a longer hedgerow nearby.\n\nMore about hedgerows here.'],
      [sec('guide', 2, 'Trading rules'), 'A medium distinctiveness habitat must be replaced within the same broad group.'],
      [sec('guide', 3, 'Refunds'), 'Refunds are paid within fourteen days. A refund needs a receipt.'],
    ]);
    expect(paths(await run('hedgerows'))).toEqual(['guide/sections/01-hedgerows.md']);
    // "replaced" is in two sections; with "habitat" only the second matches.
    expect(paths(await run('replaced habitat'))).toEqual(['guide/sections/02-trading-rules.md']);
    expect((await run('replaced')).total).toBe(2);
    expect((await run('hedgerow quantum')).total).toBe(0);
    // Stemmed: "refunding" → "refund".
    const r = await run('refunding');
    expect(paths(r)).toEqual(['guide/sections/03-refunds.md']);
    expect(r.results[0]!.sectionTitle).toBe('Refunds');
    expect(r.results[0]!.trail).toEqual(['Part one']);
    expect(r.results[0]!.docAddedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(r.results[0]!.snippet.filter((p) => p.match).map((p) => p.text.toLowerCase())).toEqual(['refunds', 'refund']);
    expect(r.results[0]!.matchedWords).toEqual(expect.arrayContaining(['refunds', 'refund']));
    expect(r.indexed).toBe(true);
  });

  it('every word must be in the SECTION, not in one passage of it', async () => {
    // Two paragraphs of ~150 words each: the section is cut into two passages.
    const filler = (w: string): string => Array.from({ length: 150 }, () => w).join(' ');
    await doc(1, wsA, 'long', 'Long', [[sec('long', 1, 'Long read'), `Osprey ${filler('lorem')}\n\n${filler('ipsum')} heron`]]);
    const ids = client.rawSqlite.prepare("select count(*) as n from reference_doc_chunks where section_path = 'long/sections/01-long-read.md'").get() as { n: number };
    expect(ids.n).toBe(2);
    expect(paths(await run('osprey heron'))).toEqual(['long/sections/01-long-read.md']);
    expect((await run('osprey kestrelish')).total).toBe(0);
    // The words of the best passage are the ones marked.
    expect((await run('osprey heron')).results[0]!.matchedWords.length).toBeGreaterThan(0);
  });

  it('a quoted run is a phrase', async () => {
    expect((await run('"broad group"')).total).toBe(1);
    expect((await run('"group broad"')).total).toBe(0);
    expect((await run('broad group')).total).toBe(1);
  });

  it('never lets FTS5 syntax through', async () => {
    for (const evil of ['"); drop table x; --', 'hedgerow OR habitat', 'text:hedgerow', 'NEAR(hedgerow habitat)', 'hedge*', '^hedgerow', '"unclosed']) {
      await expect(run(evil)).resolves.toBeDefined();
    }
    // OR is a word here, not an operator: nothing says "or" AND both words.
    expect((await run('hedgerow OR habitat')).total).toBe(0);
    // A prefix query would widen "hedge" to "hedgerow"; quoted, it does not.
    expect((await run('hedge*')).total).toBe(0);
  });

  it("never returns another account's or another workspace's sections", async () => {
    await doc(2, wsB, 'guide', 'B guide', [[sec('guide', 1, 'Hedgerows'), 'B hedgerow text.']]);
    await doc(1, wsA2, 'other', 'Other', [[sec('other', 1, 'Hedgerows'), 'Second workspace hedgerow text.']]);
    const a = await run('hedgerow');
    expect(a.results.every((x) => x.docId === guideId)).toBe(true);
    expect((await run('hedgerow', { ws: wsB })).total).toBe(0);
    // Mutation check: B's own search sees B's.
    expect((await run('hedgerow', { acct: 2, ws: wsB })).results.map((x) => x.docTitle)).toEqual(['B guide']);
  });

  it('only the current build counts', async () => {
    client.rawSqlite.prepare('update reference_docs set built_at = built_at + 5 where id = ?').run(guideId);
    expect((await run('hedgerow')).total).toBe(0);
    await chunks.indexDocChunks(1, guideId);
    expect((await run('hedgerow')).total).toBe(1);
  });

  it('scores within 5% are a tie, newest document first; newest sort orders by date', async () => {
    const ws = wsA2;
    // Two near-identical sections score within 5%: the newer one wins the tie, though it scores a
    // little lower and its path sorts last.
    await doc(1, ws, 'a-old', 'Old', [[sec('a-old', 1, 'Zebra'), 'Zebra crossings are painted white.']], 1_600_000_000);
    await doc(1, ws, 'z-new', 'New', [[sec('z-new', 1, 'Zebra'), 'Zebra crossings are painted white today.']], 1_650_000_000);
    expect((await run('zebra', { ws })).results.map((x) => x.docTitle)).toEqual(['New', 'Old']);
    // A much stronger match in the oldest document still leads on relevance, and falls last when newest.
    await doc(1, ws, 'ancient', 'Ancient', [[sec('ancient', 1, 'Zebra zebra'), 'Zebra zebra zebra. Zebra zebra zebra zebra.']], 1_500_000_000);
    expect((await run('zebra', { ws })).results.map((x) => x.docTitle)).toEqual(['Ancient', 'New', 'Old']);
    expect((await run('zebra', { ws, sort: 'newest' })).results.map((x) => x.docTitle)).toEqual(['New', 'Old', 'Ancient']);
  });

  it('pages by 20 with the total; past the end is an empty page', async () => {
    const sections: Array<[ReferenceDocSectionEntry, string]> = Array.from({ length: 45 }, (_, i) => [sec('big', i + 1, `Part ${i + 1}`), `Kestrel note number ${i + 1}.`]);
    await doc(1, wsA, 'big', 'Big', sections);
    const p1 = await run('kestrel');
    expect([p1.total, p1.results.length, p1.pageSize, p1.totalCapped]).toEqual([45, 20, 20, false]);
    const p3 = await run('kestrel', { page: 3 });
    expect(p3.results).toHaveLength(5);
    const all = [...p1.results, ...(await run('kestrel', { page: 2 })).results, ...p3.results].map((x) => x.path);
    expect(new Set(all).size).toBe(45);
    const p9 = await run('kestrel', { page: 9 });
    expect([p9.total, p9.results.length]).toEqual([45, 0]);
  });
});
