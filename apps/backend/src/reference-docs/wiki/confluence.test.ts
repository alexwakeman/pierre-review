/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfluencePageUrl, parseConfluenceSpaceUrl } from '@pierre-review/shared';
import type { JiraTransport, RawResponse } from '../../tracker/jira/fetch.js';
import { confluenceGetJson, confluenceSource, cqlSince, nextUrl, orderTree, retryAfterMs } from './confluence.js';
import { WikiSourceError, type WikiPageRef } from './source.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { PageTransport } from '../url-fetch.js';
import { folderFigureSink } from '../figures.js';

// THE CONFLUENCE ADAPTER against RECORDED answers (__fixtures__/confluence/*.json) through a fake
// transport — no real Confluence call. Pinned: address parsing, the page / tree / change-search reads,
// pagination that stays on the site, the folder-transparent tree order, the auth header, 429 with
// Retry-After (waited, then given up), and the status → code mapping.

const fx = (name: string): string => readFileSync(join(__dirname, '__fixtures__/confluence', name), 'utf8');
const SITE: WikiPageRef = { provider: 'confluence', origin: 'https://acme.atlassian.net', host: 'acme.atlassian.net', pageId: '1001' };
const CRED = { credential: { email: 'me@acme.test', token: 'tok-123' } };

const json = (body: string, status = 200, headers: Record<string, string> = {}): RawResponse => ({ status, contentType: 'application/json', body, headers });

function fakeTransport(route: (url: URL) => RawResponse): { transport: JiraTransport; calls: Array<{ url: string; auth: string | undefined }> } {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const transport: JiraTransport = async (url, headers) => {
    calls.push({ url: url.href, auth: headers.authorization });
    return route(url);
  };
  return { transport, calls };
}

describe('parseConfluencePageUrl', () => {
  it('reads the page id from every page address shape', () => {
    expect(parseConfluencePageUrl('https://acme.atlassian.net/wiki/spaces/PAY/pages/1001/Payments+handbook')).toEqual({
      origin: 'https://acme.atlassian.net',
      host: 'acme.atlassian.net',
      pageId: '1001',
    });
    expect(parseConfluencePageUrl('https://acme.atlassian.net/wiki/spaces/PAY/pages/edit-v2/1001')?.pageId).toBe('1001');
    expect(parseConfluencePageUrl('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=1001')?.pageId).toBe('1001');
    expect(parseConfluencePageUrl('https://wiki.acme.com/wiki/spaces/X/pages/77')?.host).toBe('wiki.acme.com');
  });
  it('refuses what names no page', () => {
    expect(parseConfluencePageUrl('http://acme.atlassian.net/wiki/spaces/PAY/pages/1001')).toBeNull();
    expect(parseConfluencePageUrl('https://acme.atlassian.net/wiki/x/AQAB')).toBeNull();
    expect(parseConfluencePageUrl('https://acme.atlassian.net/wiki/spaces/PAY/overview')).toBeNull();
    expect(parseConfluencePageUrl('https://me:pw@acme.atlassian.net/wiki/spaces/PAY/pages/1')).toBeNull();
    expect(parseConfluencePageUrl('https://example.com/spaces/PAY/pages/1001')).toBeNull();
    expect(parseConfluencePageUrl('not a url')).toBeNull();
  });
});

describe('the adapter', () => {
  it('reads a page with its body, version and address, with Basic auth', async () => {
    const { transport, calls } = fakeTransport(() => json(fx('page-root.json')));
    const page = await confluenceSource({ transport }).getPage(SITE, '1001', { ...CRED, body: true });
    expect(page).toMatchObject({ id: '1001', title: 'Payments handbook', version: 14, parentId: null });
    expect(page.editedAt?.toISOString()).toBe('2026-10-20T14:05:11.000Z');
    expect(page.body).toContain('How the payments team works.');
    expect(page.webUrl).toBe('https://acme.atlassian.net/wiki/spaces/PAY/pages/1001/Payments+handbook');
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/wiki/api/v2/pages/1001?body-format=storage');
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('me@acme.test:tok-123').toString('base64')}`);
    // Metadata only: no body format asked.
    await confluenceSource({ transport }).getPage(SITE, '1001', { ...CRED, body: false });
    expect(calls[1]!.url).toBe('https://acme.atlassian.net/wiki/api/v2/pages/1001');
  });

  it('lists the tree across pages of results, folders transparent, archived and whiteboards left out', async () => {
    const { transport, calls } = fakeTransport((url) => json(fx(url.searchParams.has('cursor') ? 'descendants-2.json' : 'descendants-1.json')));
    const { pages, more } = await confluenceSource({ transport }).listDescendants(SITE, '1001', 2, 99, CRED);
    expect(calls.map((c) => c.url)).toEqual([
      'https://acme.atlassian.net/wiki/api/v2/pages/1001/descendants?depth=2&limit=250',
      'https://acme.atlassian.net/wiki/api/v2/pages/1001/descendants?depth=2&limit=250&cursor=eyJpZCI6IjEwMDQifQ',
    ]);
    expect(pages.map((p) => [p.id, p.parentId, p.depth])).toEqual([
      ['1002', '1001', 1],
      ['1003', '1001', 1],
      ['1004', '1003', 2],
      ['1005', '1001', 1],
    ]);
    expect(more).toBe(false);
    // The cap applies in reading order and says there is more.
    const capped = orderTree('1001', JSON.parse(fx('descendants-1.json')).results.map((r: any) => ({ ...r, version: null, editedAt: null, position: r.childPosition })), 2, 2);
    expect(capped.pages.map((p) => p.id)).toEqual(['1002', '1003']);
    expect(capped.more).toBe(true);
    // Depth 1 drops the grandchild.
    const shallow = await confluenceSource({ transport }).listDescendants(SITE, '1001', 1, 99, CRED);
    expect(shallow.pages.map((p) => p.id)).not.toContain('1004');
  });

  it('finds the changed pages with a CQL search, a day early, under the root', async () => {
    const { transport, calls } = fakeTransport(() => json(fx('search-changed.json')));
    const changed = await confluenceSource({ transport }).changedSince(SITE, '1001', new Date('2026-10-26T10:30:00Z'), CRED);
    expect(changed).toEqual([expect.objectContaining({ id: '1003', version: 7 })]);
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/wiki/rest/api/content/search');
    expect(u.searchParams.get('cql')).toBe('ancestor = 1001 AND type = page AND lastmodified > "2026-10-25 10:30"');
    expect(u.searchParams.get('expand')).toBe('version');
    expect(cqlSince(new Date('2026-01-01T00:05:00Z'))).toBe('2025-12-31 00:05');
  });

  it('follows a next link only on the same site and API path', () => {
    expect(nextUrl('https://acme.atlassian.net', '/wiki/api/v2/pages/1/descendants?cursor=x', '/wiki/api/v2/pages/1/descendants')).toBe(
      'https://acme.atlassian.net/wiki/api/v2/pages/1/descendants?cursor=x',
    );
    expect(nextUrl('https://acme.atlassian.net', 'https://evil.test/wiki/api/v2/pages/1/descendants', '/wiki/api/v2/pages/1/descendants')).toBeNull();
    expect(nextUrl('https://acme.atlassian.net', '/wiki/rest/api/user', '/wiki/api/v2/pages/1/descendants')).toBeNull();
  });

  it('maps statuses to codes and never parses a non-JSON body', async () => {
    const at = (status: number, contentType = "application/json"): Promise<any> =>
      confluenceGetJson('https://acme.atlassian.net/wiki/api/v2/pages/1', CRED, { transport: async () => ({ status, contentType, body: '<html>' }) }).catch((e: any) => e as any);
    expect((await at(404)).code).toBe('not_found');
    expect((await at(403)).code).toBe('forbidden');
    expect((await at(401)).code).toBe('unauthorized');
    expect((await at(302)).code).toBe('redirect');
    expect((await at(500)).code).toBe('http');
    expect((await at(200, 'text/html')).code).toBe('not_json');
  });

  it('refuses http and private addresses before any request', async () => {
    let called = false;
    const transport: JiraTransport = async () => {
      called = true;
      return json('{}');
    };
    for (const url of ['http://acme.atlassian.net/wiki/api/v2/pages/1', 'https://127.0.0.1/wiki/api/v2/pages/1', 'https://10.0.0.5/wiki/api/v2/pages/1', 'https://localhost/wiki']) {
      const err: any = await confluenceGetJson(url, CRED, { transport }).catch((e: any) => e);
      expect(err).toBeInstanceOf(WikiSourceError);
      expect(['blocked', 'bad_url']).toContain(err.code);
    }
    expect(called).toBe(false);
  });
});

describe('429 — Retry-After is honoured', () => {
  it('waits the server asks, then reads', async () => {
    const waits: number[] = [];
    let n = 0;
    const transport: JiraTransport = async () => (n++ === 0 ? json('{}', 429, { 'retry-after': '3' }) : json(fx('page-root.json')));
    const page = await confluenceSource({ transport, sleep: async (ms) => void waits.push(ms) }).getPage(SITE, '1001', { ...CRED, body: false });
    expect(page.id).toBe('1001');
    expect(waits).toEqual([3000]);
  });

  it('gives up with rate_limited (and the wait) when the server asks for too long', async () => {
    const waits: number[] = [];
    const transport: JiraTransport = async () => json('{}', 429, { 'retry-after': '600' });
    const err = await confluenceSource({ transport, sleep: async (ms) => void waits.push(ms) })
      .getPage(SITE, '1001', { ...CRED, body: false })
      .catch((e: any) => e as any);
    expect(err).toBeInstanceOf(WikiSourceError);
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(600_000);
    expect(waits).toEqual([]);
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('12')).toBe(12_000);
    expect(retryAfterMs(new Date(Date.UTC(2026, 0, 1, 0, 0, 30)).toUTCString(), Date.UTC(2026, 0, 1))).toBe(30_000);
    expect(retryAfterMs('soon')).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });
});

describe('figures (docs/REFERENCE-DOCS.md § Figures)', () => {
  it('an image attachment is downloaded (the media redirect followed WITHOUT the credential); a draw.io file becomes an outline', async () => {
    const png = Buffer.alloc(4096);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="a" value="Shop" vertex="1"/><mxCell id="b" value="Bank" vertex="1"/><mxCell id="e" value="pays" edge="1" source="a" target="b"/></root></mxGraphModel></diagram></mxfile>';
    const { transport, calls } = fakeTransport((url) => {
      const file = url.searchParams.get('filename');
      if (url.pathname.endsWith('/attachments') && file === 'flow.png') return json(JSON.stringify({ results: [{ downloadLink: '/download/attachments/1001/flow.png?api=v2' }] }));
      if (url.pathname.endsWith('/attachments') && file === 'Checkout') return json(JSON.stringify({ results: [{ downloadLink: '/download/attachments/1001/Checkout?api=v2' }] }));
      if (url.pathname.endsWith('/attachments')) return json(JSON.stringify({ results: [] }));
      if (url.pathname === '/wiki/download/attachments/1001/flow.png') return { status: 302, contentType: '', body: '', headers: { location: 'https://api.media.atlassian.com/file/abc/binary?token=signed' } };
      if (url.pathname === '/wiki/download/attachments/1001/Checkout') return { status: 200, contentType: 'application/vnd.jgraph.mxfile', body: xml, headers: {} };
      return json('{}', 404);
    });
    const media: string[] = [];
    const pageTransport: PageTransport = async (url) => {
      media.push(url.href);
      return { status: 200, contentType: 'image/png', location: null, body: png };
    };
    const dir = mkdtempSync(join(tmpdir(), 'conf-fig-'));
    try {
      const src = confluenceSource({ transport, pageTransport });
      const page = {
        id: '1001', title: 'Checkout', parentId: null, version: 3, editedAt: null, depth: 0, position: null,
        webUrl: 'https://acme.atlassian.net/wiki/spaces/PAY/pages/1001/Checkout',
        body: '<p>Intro</p><ac:image ac:alt="Flow"><ri:attachment ri:filename="flow.png"/></ac:image><ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">Checkout</ac:parameter></ac:structured-macro>',
      };
      const md = await src.toMarkdown(page, { ...CRED, figures: folderFigureSink(dir) });
      expect(md).toMatch(/\[\[limn-figure:[0-9a-f]{64}:Image: Flow\]\]/);
      expect(md).toContain('[Diagram outline from its draw.io source: Checkout]');
      expect(md).toContain('- Shop → Bank: pays');
      expect(media).toEqual(['https://api.media.atlassian.com/file/abc/binary?token=signed']);
      // The credential went to Confluence only, never to the media host.
      expect(calls.every((c) => c.url.startsWith('https://acme.atlassian.net/') && c.auth?.startsWith('Basic '))).toBe(true);
      // Without a sink, nothing is downloaded and the names stay.
      const plain = await src.toMarkdown(page);
      expect(plain).toContain('[Image: Flow]');
      expect(plain).toContain('[Diagram: Checkout]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// THE WIZARD'S SCOPES: a space address, a page that is the space's home (→ the whole space), any other
// page (→ it and every page below it, past the listing's 5 levels), and the space-wide change search.
describe('scopes', () => {
  const page = (id: string, parentId: string, depth: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    type: 'page',
    status: 'current',
    title: `Page ${id}`,
    parentId,
    depth,
    childPosition: Number(id),
    ...extra,
  });

  it('reads a space address and finds its home page', async () => {
    expect(parseConfluenceSpaceUrl('https://acme.atlassian.net/wiki/spaces/ENG/overview')).toEqual({
      origin: 'https://acme.atlassian.net',
      host: 'acme.atlassian.net',
      spaceKey: 'ENG',
    });
    expect(parseConfluenceSpaceUrl('https://acme.atlassian.net/wiki/spaces/~abc12')?.spaceKey).toBe('~abc12');
    expect(parseConfluenceSpaceUrl('https://acme.atlassian.net/wiki/spaces/ENG/pages/1001')).toBeNull();
    const src = confluenceSource({
      transport: fakeTransport((u) =>
        u.pathname === '/wiki/api/v2/spaces' ? json(JSON.stringify({ results: [{ id: '55', key: 'ENG', name: 'Engineering', homepageId: '900' }] })) : json('{}', 404),
      ).transport,
    });
    const ref = src.resolveRef('https://acme.atlassian.net/wiki/spaces/ENG')!;
    expect(ref.pageId).toBe('');
    const root = await src.resolveRoot!(ref, CRED);
    expect(root.ref.pageId).toBe('900');
    expect(root.title).toBe('Engineering');
    expect(root.scope).toEqual({ kind: 'space', name: 'Engineering', key: 'ENG', id: '55' });
  });

  it('a page that is the space home reads the whole space; any other page is a tree', async () => {
    const route = (u: URL): RawResponse => {
      if (u.pathname === '/wiki/api/v2/pages/900') return json(JSON.stringify({ id: '900', title: 'Home', spaceId: '55' }));
      if (u.pathname === '/wiki/api/v2/pages/950') return json(JSON.stringify({ id: '950', title: 'Runbooks', spaceId: '55', parentId: '900' }));
      if (u.pathname === '/wiki/api/v2/spaces/55') return json(JSON.stringify({ id: '55', key: 'ENG', name: 'Engineering', homepageId: '900' }));
      return json('{}', 404);
    };
    const src = confluenceSource({ transport: fakeTransport(route).transport });
    const home = await src.resolveRoot!({ ...SITE, pageId: '900' }, CRED);
    expect(home.scope).toMatchObject({ kind: 'space', key: 'ENG' });
    const child = await src.resolveRoot!({ ...SITE, pageId: '950' }, CRED);
    expect(child.scope).toEqual({ kind: 'tree' });
    expect(child.title).toBe('Runbooks');
  });

  it('a tree lists every level below the root, past the listing’s five, and never a sibling', async () => {
    const { transport, calls } = fakeTransport((u) => {
      if (u.pathname === '/wiki/api/v2/pages/1/descendants') {
        // Levels 1–5 below 1; page 6 sits on the 5th level.
        return json(JSON.stringify({ results: [page('2', '1', 1), page('3', '2', 2), page('4', '3', 3), page('5', '4', 4), page('6', '5', 5)] }));
      }
      if (u.pathname === '/wiki/api/v2/pages/6/descendants') return json(JSON.stringify({ results: [page('7', '6', 1)] }));
      return json('{}', 404);
    });
    const res = await confluenceSource({ transport }).listDescendants(SITE, '1', 32, 99, CRED);
    expect(res.pages.map((p) => [p.id, p.depth])).toEqual([
      ['2', 1],
      ['3', 2],
      ['4', 3],
      ['5', 4],
      ['6', 5],
      ['7', 6],
    ]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/wiki/api/v2/pages/1/descendants', '/wiki/api/v2/pages/6/descendants']);
    expect(calls.every((c) => !c.url.includes('/spaces/'))).toBe(true);
  });

  it('a space adds its other top-level pages under the home page, and searches the whole space', async () => {
    const { transport, calls } = fakeTransport((u) => {
      if (u.pathname === '/wiki/api/v2/pages/900/descendants') return json(JSON.stringify({ results: [page('901', '900', 1)] }));
      if (u.pathname === '/wiki/api/v2/spaces/55/pages') return json(JSON.stringify({ results: [{ id: '900', status: 'current', title: 'Home' }, { id: '980', status: 'current', title: 'Archive', position: 1 }] }));
      if (u.pathname === '/wiki/api/v2/pages/980/descendants') return json(JSON.stringify({ results: [page('981', '980', 1)] }));
      if (u.pathname === '/wiki/rest/api/content/search') return json(JSON.stringify({ results: [] }));
      return json('{}', 404);
    });
    const space: WikiPageRef = { ...SITE, pageId: '900', scope: { kind: 'space', name: 'Engineering', key: 'ENG', id: '55' } };
    const src = confluenceSource({ transport });
    const res = await src.listDescendants(space, '900', 32, 99, CRED);
    expect(res.pages.map((p) => [p.id, p.parentId, p.depth])).toEqual([
      ['901', '900', 1],
      ['980', '900', 1],
      ['981', '980', 2],
    ]);
    await src.changedSince(space, '900', new Date('2026-10-20T00:00:00Z'), CRED);
    const cql = new URL(calls[calls.length - 1]!.url).searchParams.get('cql');
    expect(cql).toContain('space = "ENG"');
    expect(cql).not.toContain('ancestor');
  });
});
