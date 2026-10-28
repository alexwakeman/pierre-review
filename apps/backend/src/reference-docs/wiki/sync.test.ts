import { describe, expect, it } from 'vitest';
import type { ReferenceDocWikiState } from '@pierre-review/shared';
import { fakeWiki, type FakePage } from './fake-wiki.js';
import { WikiSourceError } from './source.js';
import { bundleWikiMarkdown, checkWikiTree, syncWikiTree, type StoredWikiPage, type SyncedWikiPage } from './sync.js';

// CHANGE DETECTION over an in-memory wiki (fake-wiki.ts): the cheap check reads no body and says
// "changed" only when a version, a new page or (daily) the tree moved; the build's read fetches only
// the changed pages, and a version bump whose converted text is identical rebuilds nothing.

const T0 = new Date('2026-10-01T00:00:00Z');
const DAY = 24 * 3600_000;
const SITE = { provider: 'confluence' as const, origin: 'https://acme.atlassian.net', host: 'acme.atlassian.net', pageId: '1' };
const CRED = { email: 'me@acme.test', token: 't' };

const seed = (): FakePage[] => [
  { id: '1', title: 'Handbook', parentId: null, version: 3, editedAt: T0, body: 'Root text.' },
  { id: '2', title: 'Refunds', parentId: '1', version: 1, editedAt: T0, body: 'Refunds take 14 days.', position: 1 },
  { id: '3', title: 'Invoices', parentId: '1', version: 1, editedAt: T0, body: 'Invoices go out monthly.', position: 2 },
  { id: '4', title: 'Partial refunds', parentId: '2', version: 1, editedAt: T0, body: 'Need a manager.', position: 1 },
];

const state = (over: Partial<ReferenceDocWikiState> = {}): ReferenceDocWikiState => ({
  provider: 'confluence',
  origin: SITE.origin,
  rootPageId: '1',
  rootUrl: 'https://acme.atlassian.net/wiki/spaces/PAY/pages/1',
  depth: 2,
  pageCount: null,
  pagesLeftOut: 0,
  lastCheckedAt: null,
  lastListedAt: null,
  lastChangedAt: null,
  unreachableSince: null,
  unreachableReason: null,
  retryAfter: null,
  ...over,
});

const toStored = (pages: SyncedWikiPage[]): StoredWikiPage[] =>
  pages.map((p) => ({
    pageId: p.pageId,
    parentPageId: p.parentPageId,
    depth: p.depth,
    position: p.position,
    title: p.title,
    version: p.version,
    lastEditedAt: p.lastEditedAt,
    contentHash: p.contentHash,
  }));

/** A first full read, then the stored rows + cache a later sync starts from. */
async function firstSync(wiki = fakeWiki(seed())) {
  const now = new Date(T0.getTime() + DAY);
  const res = await syncWikiTree({ source: wiki, site: SITE, state: state(), stored: [], credential: CRED, readCached: () => null, full: true, now });
  const cache = new Map(res.pages.map((p) => [p.pageId, p.markdown]));
  const st = state({ lastCheckedAt: now.getTime(), lastListedAt: now.getTime(), pageCount: res.pages.length });
  wiki.resetCalls();
  return { wiki, res, cache, stored: toStored(res.pages), st, now };
}

describe('the first read', () => {
  it('lists the tree and reads every page, in reading order', async () => {
    const wiki = fakeWiki(seed());
    const res = await syncWikiTree({ source: wiki, site: SITE, state: state(), stored: [], credential: CRED, readCached: () => null, full: true, now: T0 });
    expect(res.pages.map((p) => [p.pageId, p.depth, p.parentPageId])).toEqual([
      ['1', 0, null],
      ['2', 1, '1'],
      ['4', 2, '2'],
      ['3', 1, '1'],
    ]);
    expect(res.fetched).toBe(4);
    expect(res.contentChanged).toBe(true);
    expect(wiki.calls.list).toBe(1);
  });

  it('depth 0 reads the page only', async () => {
    const wiki = fakeWiki(seed());
    const res = await syncWikiTree({ source: wiki, site: SITE, state: state({ depth: 0 }), stored: [], credential: CRED, readCached: () => null, full: true, now: T0 });
    expect(res.pages.map((p) => p.pageId)).toEqual(['1']);
    expect(wiki.calls.list).toBe(0);
  });
});

describe('checkWikiTree — the cheap check', () => {
  it('nothing moved: unchanged, and no body is read', async () => {
    const { wiki, stored, st, now } = await firstSync();
    const res = await checkWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, now: new Date(now.getTime() + 3600_000) });
    expect(res).toEqual({ changed: false, listed: false });
    expect(wiki.calls.getBody).toEqual([]);
    expect(wiki.calls.getMeta).toEqual(['1']);
  });

  it('a child edit is a change; so is a root edit', async () => {
    const { wiki, stored, st, now } = await firstSync();
    wiki.edit('4', 'Need two managers.', new Date(now.getTime() + 60_000));
    expect((await checkWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, now })).changed).toBe(true);
    const b = await firstSync();
    b.wiki.edit('1', 'New root text.');
    expect((await checkWikiTree({ source: b.wiki, site: SITE, state: b.st, stored: b.stored, credential: CRED, now: b.now })).changed).toBe(true);
    expect(b.wiki.calls.getBody).toEqual([]);
  });

  it('once a day, the id list: a deleted or moved page is a change', async () => {
    const { wiki, stored, st, now } = await firstSync();
    wiki.pages.delete('3');
    const sameDay = await checkWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, now: new Date(now.getTime() + 3600_000) });
    expect(sameDay).toEqual({ changed: false, listed: false });
    const nextDay = await checkWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, now: new Date(now.getTime() + DAY + 1) });
    expect(nextDay).toEqual({ changed: true, listed: true });
  });

  it('a root that is gone throws (the caller keeps the last version)', async () => {
    const { wiki, stored, st, now } = await firstSync();
    wiki.failing.set('1', new WikiSourceError('not_found', 404));
    await expect(checkWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, now })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('syncWikiTree — the refresh read', () => {
  it('reads ONLY the changed page; the rest come from the cache', async () => {
    const { wiki, cache, stored, st, now } = await firstSync();
    wiki.edit('4', 'Need two managers.', new Date(now.getTime() + 60_000));
    const res = await syncWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, readCached: (id) => cache.get(id) ?? null, full: false, now: new Date(now.getTime() + 3600_000) });
    expect(wiki.calls.getBody).toEqual(['4']);
    expect(wiki.calls.list).toBe(0);
    expect(res.fetched).toBe(1);
    expect(res.contentChanged).toBe(true);
    expect(res.pages.find((p) => p.pageId === '4')).toMatchObject({ fetched: true, markdown: 'Need two managers.', version: 2 });
    expect(res.pages.find((p) => p.pageId === '2')).toMatchObject({ fetched: false, markdown: 'Refunds take 14 days.' });
  });

  it('a version bump with the same text changes nothing', async () => {
    const { wiki, cache, stored, st, now } = await firstSync();
    wiki.edit('3', 'Invoices go out monthly.', new Date(now.getTime() + 60_000));
    const res = await syncWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, readCached: (id) => cache.get(id) ?? null, full: false, now: new Date(now.getTime() + 3600_000) });
    expect(wiki.calls.getBody).toEqual(['3']);
    expect(res.contentChanged).toBe(false);
  });

  it('a new child page lists the tree again and reads only the new page', async () => {
    const { wiki, cache, stored, st, now } = await firstSync();
    wiki.pages.set('5', { id: '5', title: 'Disputes', parentId: '1', version: 1, editedAt: new Date(now.getTime() + 60_000), body: 'Disputes text.', position: 3 });
    const res = await syncWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, readCached: (id) => cache.get(id) ?? null, full: false, now: new Date(now.getTime() + 3600_000) });
    expect(wiki.calls.list).toBe(1);
    expect(wiki.calls.getBody).toEqual(['5']);
    expect(res.pages.map((p) => p.pageId)).toEqual(['1', '2', '4', '3', '5']);
    expect(res.contentChanged).toBe(true);
  });

  it('a child that fails keeps its last text; a child that is gone leaves the tree; a root that fails throws', async () => {
    const { wiki, cache, stored, st, now } = await firstSync();
    wiki.edit('2', 'x', new Date(now.getTime() + 60_000));
    wiki.edit('3', 'y', new Date(now.getTime() + 60_000));
    wiki.failing.set('2', new WikiSourceError('forbidden', 403));
    wiki.failing.set('3', new WikiSourceError('not_found', 404));
    const res = await syncWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, readCached: (id) => cache.get(id) ?? null, full: false, now: new Date(now.getTime() + 3600_000) });
    expect(res.pages.find((p) => p.pageId === '2')).toMatchObject({ markdown: 'Refunds take 14 days.', lastError: 'forbidden' });
    expect(res.pages.map((p) => p.pageId)).not.toContain('3');
    wiki.failing.set('1', new WikiSourceError('forbidden', 403));
    wiki.edit('1', 'z');
    await expect(
      syncWikiTree({ source: wiki, site: SITE, state: st, stored, credential: CRED, readCached: (id) => cache.get(id) ?? null, full: false, now }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('bundleWikiMarkdown', () => {
  it('nests each page under its parent by depth and pushes its headings below its title', () => {
    const md = bundleWikiMarkdown([
      { title: 'Handbook', depth: 0, markdown: '# Handbook\n\nIntro.\n\n## Contacts\n\nAsk us.', url: 'https://w/1' },
      { title: 'Refunds', depth: 1, markdown: '## Rules\n\n```\n# not a heading\n```', url: 'https://w/2' },
    ]);
    expect(md).toContain('# Handbook\n\nSource: <https://w/1>\n\nIntro.');
    expect(md).toContain('### Contacts');
    expect(md).toContain('## Refunds\n\nSource: <https://w/2>');
    expect(md).toContain('#### Rules');
    expect(md).toContain('# not a heading');
  });
});
