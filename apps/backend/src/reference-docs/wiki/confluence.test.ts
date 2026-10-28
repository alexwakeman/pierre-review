/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfluencePageUrl } from '@pierre-review/shared';
import type { JiraTransport, RawResponse } from '../../tracker/jira/fetch.js';
import { confluenceGetJson, confluenceSource, cqlSince, nextUrl, orderTree, retryAfterMs } from './confluence.js';
import { WikiSourceError, type WikiPageRef } from './source.js';

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
