// FULL-TEXT RETRIEVAL over the REAL core client (a scratch SQLite, every migration) and a scratch docs
// folder (docs/REFERENCE-DOCS.md § Retrieval). Pinned:
//   1. indexDocChunks cuts a built document's files into passages; FTS5 finds them by word (stemmed).
//   2. Tenancy: another account's passages, and another workspace's, are never returned.
//   3. Only a document's CURRENT build counts; a re-index replaces its passages whole.
//   4. The triggers keep FTS5 in step through a document delete, a workspace delete and an erasure
//      (FTS5's own integrity check passes after each).
//   5. null ⇒ nothing indexed (the caller falls back); [] ⇒ indexed and nothing matched.
//   6. The boot backfill indexes exactly the documents that need it.
//
//   DATABASE_URL=<scratch> pnpm --filter @pierre-review/backend test retrieve-db
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReferenceDocSectionEntry } from '@pierre-review/shared';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-retrieve`}.retrieve-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let client: typeof import('../db/client.js');
let store: typeof import('./store.js');
let chunks: typeof import('./chunks.js');
let retrieve: typeof import('./retrieve.js');
let docsDir: string;
let wsA = 0;
let wsA2 = 0;
let wsB = 0;

const sec = (slug: string, n: number, title: string, summary = ''): ReferenceDocSectionEntry => ({
  path: `${slug}/sections/0${n}-${title.toLowerCase().replace(/\s+/g, '-')}.md`,
  title,
  summary,
  depth: 1,
  trail: [],
  headings: [],
  words: 10,
});

/** Insert a built document and write its section files; returns its id. */
async function builtDoc(acct: number, ws: number, slug: string, title: string, sections: Array<[ReferenceDocSectionEntry, string]>): Promise<number> {
  const { libraryDir } = await import('./paths.js');
  const row = await store.insertDocRow({ accountId: acct, workspaceId: ws, slug, title, sourceKind: 'markdown', sourceName: `${slug}.md`, sourceUrl: null, byteSize: 1, pageCount: null });
  for (const [s, body] of sections) {
    const file = join(libraryDir(acct, ws), s.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `<!-- limn reference section 1 of 1 -->\n# ${s.title}\n\n> crumbs\n> nav\n\n${body}\n`);
  }
  await store.saveDocBuilt(acct, row.id, { title, summary: 's', topics: [], sections: sections.map(([s]) => s) }, {});
  return row.id;
}

const count = async (where: string): Promise<number> => (client.rawSqlite.prepare(`select count(*) n from reference_doc_chunks ${where}`).get() as { n: number }).n;
const ftsOk = (): void => {
  // FTS5 throws "database disk image is malformed" when the index and its content table disagree. The
  // `rank` of 1 is what makes it compare against the content table (without it, a missing delete
  // trigger passes).
  client.rawSqlite.prepare(`insert into reference_doc_chunks_fts(reference_doc_chunks_fts, rank) values ('integrity-check', 1)`).run();
};
const ftsRows = (): number => (client.rawSqlite.prepare(`select count(*) n from reference_doc_chunks_fts where reference_doc_chunks_fts match '"hedgerow" OR "refund" OR "invoice" OR "trading"'`).get() as { n: number }).n;
const paths = (r: Awaited<ReturnType<typeof retrieve.retrieveSections>>): string[] | null => (r == null ? null : r.map((s) => s.path));

let guideId = 0;
let specId = 0;

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  docsDir = mkdtempSync(join(tmpdir(), 'limn-retrieve-'));
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
  retrieve = await import('./retrieve.js');
});

afterAll(async () => {
  await client?.closeDb();
  rmSync(docsDir, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

describe('indexing and search', () => {
  it('nothing indexed yet ⇒ null, so the caller falls back', async () => {
    guideId = await builtDoc(1, wsA, 'guide', 'Metric guide', [
      [sec('guide', 1, 'Hedgerows', 'How hedgerows are scored.'), 'A hedgerow lost on site is replaced by planting a longer hedgerow nearby.'],
      [sec('guide', 2, 'Trading rules'), 'A medium distinctiveness habitat must be replaced within the same broad group.'],
    ]);
    expect(await retrieve.retrieveSections({ accountId: 1, workspaceId: wsA, query: 'hedgerows', k: 5 })).toBeNull();
  });

  it('cuts the files into passages and finds sections by stemmed words, best first', async () => {
    expect(await chunks.indexDocChunks(1, guideId)).toBe(2);
    const r = await retrieve.retrieveSections({ accountId: 1, workspaceId: wsA, query: 'What happens when hedgerows are LOST?', k: 5 });
    expect(paths(r)).toEqual(['guide/sections/01-hedgerows.md']);
    expect(r![0]!.passage).toContain('Metric guide › Hedgerows\nHow hedgerows are scored.\n\nA hedgerow lost');
    expect(paths(await retrieve.retrieveSections({ accountId: 1, workspaceId: wsA, query: 'quantum chromodynamics', k: 5 }))).toEqual([]);
    expect(paths(await retrieve.retrieveSections({ accountId: 1, workspaceId: wsA, query: '"); drop table x; --', k: 5 }))).toEqual([]);
    ftsOk();
  });

  it("never returns another account's or another workspace's passages", async () => {
    await chunks.indexDocChunks(2, await builtDoc(2, wsB, 'guide', 'B guide', [[sec('guide', 1, 'Hedgerows'), 'B hedgerow text.']]));
    await chunks.indexDocChunks(1, await builtDoc(1, wsA2, 'other', 'Other', [[sec('other', 1, 'Hedgerows'), 'Second workspace hedgerow text.']]));
    const a = await retrieve.retrieveSections({ accountId: 1, workspaceId: wsA, query: 'hedgerow', k: 10 });
    expect(a!.every((s) => s.docId === guideId)).toBe(true);
    // A's account naming B's workspace finds nothing; B's own read sees B's (mutation check).
    expect(await retrieve.retrieveSections({ accountId: 1, workspaceId: wsB, query: 'hedgerow', k: 10 })).toBeNull();
    expect(paths(await retrieve.retrieveSections({ accountId: 2, workspaceId: wsB, query: 'hedgerow', k: 10 }))).toEqual(['guide/sections/01-hedgerows.md']);
  });

  it('only the current build counts, and a re-index replaces the passages whole', async () => {
    const before = await count(`where doc_id = ${guideId}`);
    // A rebuild moved built_at: the old passages no longer count until re-indexed.
    client.rawSqlite.prepare(`update reference_docs set built_at = built_at + 5 where id = ?`).run(guideId);
    expect(await retrieve.retrieveSections({ accountId: 1, workspaceId: wsA, query: 'hedgerow', k: 5 })).toBeNull();
    expect((await chunks.docsNeedingChunks()).map((d) => d.id)).toEqual([guideId]);
    expect(await chunks.backfillDocChunks()).toBe(1);
    expect(await count(`where doc_id = ${guideId}`)).toBe(before);
    expect(paths(await retrieve.retrieveSections({ accountId: 1, workspaceId: wsA, query: 'hedgerow', k: 5 }))).toEqual(['guide/sections/01-hedgerows.md']);
    expect(await chunks.docsNeedingChunks()).toEqual([]);
    ftsOk();
  });

  it('the per-document cap keeps a second document in a short list', async () => {
    specId = await builtDoc(1, wsA, 'spec', 'Import spec', [
      [sec('spec', 1, 'Trading one'), 'Trading rule: medium habitat trading within the broad group. Trading again.'],
      [sec('spec', 2, 'Trading two'), 'Trading rule two: trading up is allowed. Trading trading.'],
      [sec('spec', 3, 'Trading three'), 'Trading rule three: trading trading trading.'],
    ]);
    await chunks.indexDocChunks(1, specId);
    const plain = await retrieve.retrieveSections({ accountId: 1, workspaceId: wsA, query: 'trading rules', k: 2 });
    expect(plain!.every((s) => s.docId === specId)).toBe(true);
    const capped = await retrieve.retrieveSections({ accountId: 1, workspaceId: wsA, query: 'trading rules', k: 2, perDocCap: 1 });
    expect(new Set(capped!.map((s) => s.docId))).toEqual(new Set([specId, guideId]));
  });
});

describe('the triggers keep FTS5 in step', () => {
  it('through a document delete', async () => {
    const n = ftsRows();
    await store.deleteDocRow(1, specId);
    expect(await count(`where doc_id = ${specId}`)).toBe(0);
    expect(ftsRows()).toBe(n - 3);
    ftsOk();
  });

  it('through a workspace delete and an erasure', async () => {
    client.rawSqlite.prepare('delete from workspaces where id = ?').run(wsA2);
    expect(await count(`where workspace_id = ${wsA2}`)).toBe(0);
    ftsOk();
    const { eraseAccountData } = await import('../db/erase-account.js');
    await eraseAccountData(2);
    expect(await count('where account_id = 2')).toBe(0);
    expect(await count('where account_id = 1')).toBeGreaterThan(0);
    ftsOk();
  });
});
