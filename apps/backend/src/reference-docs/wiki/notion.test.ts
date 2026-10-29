/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTION_TOKEN_RE, notionIdOf, parseNotionPageUrl, wikiProviderOfUrl } from '@pierre-review/shared';
import type { JiraTransport, RawResponse } from '../../tracker/jira/fetch.js';
import type { PageTransport } from '../url-fetch.js';
import { folderFigureSink } from '../figures.js';
import { NOTION_EDIT_FUZZ_MS, notionRequest, notionSource, rateLimiter, toNotionPage } from './notion.js';
import { WikiSourceError, type WikiPageRef } from './source.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// THE NOTION ADAPTER against RECORDED answers (__fixtures__/notion/api.json, keyed "METHOD /v1/path",
// a search page by its cursor) through a fake transport — no real Notion call. Pinned: address
// parsing and the token shape, the page read (title property, trash = gone), the block walk
// (pagination, nesting, synced blocks, child pages NOT entered), the tree (child pages anywhere in the
// block tree, database rows, trashed rows left out), the change search (newest first, stops past
// `since`, only the document's pages and their new children, the one-minute lateness, the cap's
// over-report), headers + fixed host, 429 + Retry-After, and the client-side limiter.

const API = JSON.parse(readFileSync(join(__dirname, '__fixtures__/notion/api.json'), 'utf8')) as Record<string, unknown>;
const R = '0a000000-0000-4000-8000-000000000001';
const P2 = '0a000000-0000-4000-8000-000000000002';
const P3 = '0a000000-0000-4000-8000-000000000003';
const P4 = '0a000000-0000-4000-8000-000000000004';
const P6 = '0a000000-0000-4000-8000-000000000006';
const SITE: WikiPageRef = { provider: 'notion', origin: 'https://www.notion.so', host: 'www.notion.so', pageId: R };
const CRED = { credential: { email: null, token: 'ntn_abcdefghijklmnopqrstuvwxyz0123456789' } };
const noWait = async (): Promise<void> => {};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): RawResponse => ({ status, contentType: 'application/json', body: JSON.stringify(body), headers });

function fake(): { transport: JiraTransport; calls: Array<{ key: string; headers: Record<string, string>; body?: any }> } {
  const calls: Array<{ key: string; headers: Record<string, string>; body?: any }> = [];
  const transport: JiraTransport = async (url, headers, _opts, init) => {
    const path = `${url.pathname}${url.search}`;
    const body = init ? JSON.parse(init.body) : undefined;
    const key = `${init ? 'POST' : 'GET'} ${path}${body?.start_cursor ? `#${body.start_cursor}` : ''}`;
    calls.push({ key, headers, body });
    const hit = API[key];
    return hit ? json(hit) : json({ object: 'error', status: 404, code: 'object_not_found' }, 404);
  };
  return { transport, calls };
}

describe('Notion addresses and tokens', () => {
  it('reads the page id from every page address shape, and a bare id', () => {
    const want = { origin: 'https://www.notion.so', host: 'www.notion.so', pageId: R };
    expect(parseNotionPageUrl('https://www.notion.so/acme/Payments-handbook-0a000000000040008000000000000001')).toEqual(want);
    expect(parseNotionPageUrl('https://notion.so/Payments-handbook-0a000000000040008000000000000001?pvs=4')).toEqual(want);
    expect(parseNotionPageUrl('https://acme.notion.site/0a000000-0000-4000-8000-000000000001#0b00')).toEqual(want);
    expect(parseNotionPageUrl('https://www.notion.so/acme/Runbooks-0d000000000040008000000000000001?v=1234&p=0a000000000040008000000000000001')).toEqual(want);
    expect(parseNotionPageUrl('0a000000000040008000000000000001')).toEqual(want);
    expect(parseNotionPageUrl(' 0A000000-0000-4000-8000-000000000001 ')).toEqual(want);
    expect(notionIdOf('0a000000000040008000000000000001')).toBe(R);
  });

  it('refuses what names no page', () => {
    expect(parseNotionPageUrl('http://www.notion.so/Page-0a000000000040008000000000000001')).toBeNull();
    expect(parseNotionPageUrl('https://www.notion.so/acme/Runbooks-0d000000000040008000000000000001?v=1234')).toBeNull();
    expect(parseNotionPageUrl('https://evil.example/Page-0a000000000040008000000000000001')).toBeNull();
    expect(parseNotionPageUrl('https://notion.so.evil.example/Page-0a000000000040008000000000000001')).toBeNull();
    expect(parseNotionPageUrl('https://me:pw@www.notion.so/Page-0a000000000040008000000000000001')).toBeNull();
    expect(parseNotionPageUrl('https://www.notion.so/acme')).toBeNull();
    expect(parseNotionPageUrl('0a00000000004000800000000000000')).toBeNull();
    expect(parseNotionPageUrl('not a url')).toBeNull();
  });

  it('routes a pasted address to its wiki', () => {
    expect(wikiProviderOfUrl('https://www.notion.so/Page-0a000000000040008000000000000001')).toBe('notion');
    expect(wikiProviderOfUrl('https://acme.atlassian.net/wiki/spaces/PAY/pages/1001')).toBe('confluence');
    expect(wikiProviderOfUrl('https://docs.example.com/guide')).toBeNull();
  });

  it('accepts both token formats and nothing else', () => {
    expect(NOTION_TOKEN_RE.test(`ntn_${'ab12'}cdefABCDEF0123456789abcdefABCDEF00`)).toBe(true);
    expect(NOTION_TOKEN_RE.test(`secret_${'AbCd'}EfGhIjKlMnOpQrStUvWxYz0123456789abcdefg`)).toBe(true);
    expect(NOTION_TOKEN_RE.test('ntn_short')).toBe(false);
    expect(NOTION_TOKEN_RE.test('https://www.notion.so/Page-0a000000000040008000000000000001')).toBe(false);
    expect(NOTION_TOKEN_RE.test('ntn_abc def ghi jkl mno pqr stu')).toBe(false);
    expect(NOTION_TOKEN_RE.test('sk-ant-0123456789abcdefghijklmnop')).toBe(false);
  });
});

describe('the transport', () => {
  it('sends the bearer token and the pinned version to the one fixed host', async () => {
    const f = fake();
    await notionRequest('/users/me', CRED, { transport: f.transport, limit: noWait });
    expect(f.calls[0]!.headers.authorization).toBe(`Bearer ${CRED.credential.token}`);
    expect(f.calls[0]!.headers['notion-version']).toBe('2022-06-28');
  });

  it('maps statuses to codes, never the body', async () => {
    const status = (s: number): JiraTransport => async () => json({ message: 'secret upstream words' }, s);
    for (const [s, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [500, 'http']] as const) {
      const err: any = await notionRequest('/pages/x', CRED, { transport: status(s), limit: noWait }).catch((e: any) => e as any);
      expect(err).toBeInstanceOf(WikiSourceError);
      expect(err.code).toBe(code);
      expect(String(err.message)).not.toContain('secret upstream');
    }
  });

  it('waits out a 429 with its Retry-After, then gives up past the bound', async () => {
    const slept: number[] = [];
    let n = 0;
    const t: JiraTransport = async () => (n++ === 0 ? json({}, 429, { 'retry-after': '2' }) : json({ ok: true }));
    expect(await notionRequest('/users/me', CRED, { transport: t, limit: noWait, sleep: async (ms) => void slept.push(ms) })).toEqual({ ok: true });
    expect(slept).toEqual([2000]);
    const always: JiraTransport = async () => json({}, 429, { 'retry-after': '120' });
    const err: any = await notionRequest('/users/me', CRED, { transport: always, limit: noWait, sleep: noWait }).catch((e: any) => e as any);
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(120_000);
  });

  it('spaces requests on the limiter (about three a second)', async () => {
    let now = 0;
    const waits: number[] = [];
    const limit = rateLimiter(350, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await limit();
    await limit();
    await limit();
    expect(waits).toEqual([350, 350]);
    now += 2000;
    await limit();
    expect(waits).toEqual([350, 350]);
  });
});

describe('reading pages', () => {
  it('a page: its title property, its last edit, and the trash means gone', async () => {
    const page = toNotionPage(API[`GET /v1/pages/${R}`]);
    expect(page).toMatchObject({ id: R, title: 'Payments handbook', parentId: null, version: null, editedAt: new Date('2026-10-20T09:15:00.000Z') });
    expect(toNotionPage(API[`GET /v1/pages/${P2}`]).parentId).toBe(R);
    expect(() => toNotionPage(API['GET /v1/pages/0a000000-0000-4000-8000-000000000009'])).toThrow(WikiSourceError);
  });

  it('the body: every block, paginated and nested, synced blocks from their original, child pages NOT entered', async () => {
    const f = fake();
    const src = notionSource({ transport: f.transport, limit: noWait });
    const page = await src.getPage(SITE, R, { ...CRED, body: true });
    const keys = f.calls.map((c) => c.key);
    expect(keys).toContain(`GET /v1/blocks/${R}/children?page_size=100&start_cursor=cursor-2`);
    expect(keys).toContain('GET /v1/blocks/0b000000-0000-4000-8000-0000000000ff/children?page_size=100');
    expect(keys.some((k) => k.includes(`/blocks/${P2}/children`))).toBe(false);
    const md = await src.toMarkdown(page);
    expect(md).toContain('## How refunds work');
    expect(md).toContain('Refunds over **1,000 EUR** need [finance approval](https://acme.example/finance) — see `refund_limit`');
    // A stranger's text stays text: no figure marker, no emphasis.
    expect(md).toContain('\\[\\[limn-figure:x\\]\\] \\*stars\\*');
    expect(md).toContain('- Check the order\n  - Look up the order id\n    1. In the admin panel\n- Check the customer');
    expect(md).toContain('1. First\n2. Second');
    expect(md).toContain('- [x] Write the runbook\n- [ ] Review it');
    expect(md).toContain('**Edge cases**\n\nPartial refunds keep the fee.');
    expect(md).toContain('```mermaid\ngraph TD\n  Request --> Approve\n  Approve --> Pay\n```');
    expect(md).toContain('| Plan | Fee |\n| --- | --- |\n| Basic | 1% \\| min 2 |');
    expect(md).toContain('Support hours are 9 to 5.');
    expect(md).toContain('> 💡 Ask in the payments channel.');
    expect(md).toContain('> Never refund twice.');
    expect(md).toContain('---');
    expect(md).toContain('```math\nfee = amount \\times 0.029\n```');
    expect(md).toContain('[Image: Refund flow]');
    expect(md).toContain('[Stripe refunds](https://stripe.com/docs/refunds)');
    expect(md).toContain('Column text.');
    // Child pages and databases are chapters of their own, never inline.
    expect(md).not.toContain('Disputes');
    expect(md).not.toContain('Runbooks');
  });

  it("an image is read during the conversion (its address expires) and becomes a figure", async () => {
    const f = fake();
    const png = Buffer.alloc(4096);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    const fetched: string[] = [];
    const pageTransport: PageTransport = async (url) => {
      fetched.push(url.href);
      return { status: 200, contentType: 'image/png', location: null, body: png };
    };
    const dir = mkdtempSync(join(tmpdir(), 'notion-fig-'));
    try {
      const src = notionSource({ transport: f.transport, limit: noWait, pageTransport });
      const page = await src.getPage(SITE, R, { ...CRED, body: true });
      const md = await src.toMarkdown(page, { ...CRED, figures: folderFigureSink(dir) });
      expect(fetched).toEqual(['https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/flow.png?X-Amz-Signature=abc']);
      expect(md).toMatch(/\[\[limn-figure:[0-9a-f]{64}:Image: Refund flow\]\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the tree', () => {
  it('child pages anywhere in the block tree, and the rows of a child database, in reading order', async () => {
    const f = fake();
    const src = notionSource({ transport: f.transport, limit: noWait });
    const { pages, more } = await src.listDescendants(SITE, R, 2, 99, CRED);
    expect(pages.map((p) => [p.title, p.parentId, p.depth])).toEqual([
      ['Disputes', R, 1],
      ['Runbook: refunds', R, 1],
      ['Chargebacks', R, 1],
    ]);
    expect(more).toBe(false);
    const capped = await src.listDescendants(SITE, R, 1, 2, CRED);
    expect(capped.pages.map((p) => p.id)).toEqual([P2, P4]);
    expect(capped.more).toBe(true);
  });
});

describe('the change search', () => {
  const since = new Date('2026-10-22T08:00:00.000Z');

  it("keeps only the document's pages and new children of them, stops past `since`, reports a minute late", async () => {
    const f = fake();
    const src = notionSource({ transport: f.transport, limit: noWait });
    const known = new Set([R, P2, P3]);
    const out = await src.changedSince(SITE, R, since, { ...CRED, known });
    expect(out.map((p) => p.id)).toEqual([P2, P6, R]);
    // A child page's edit bumps only its own time — it is found by its own id.
    expect(out[0]!.editedAt!.getTime()).toBe(Date.parse('2026-10-22T10:00:00.000Z') + NOTION_EDIT_FUZZ_MS);
    // Sorted newest first: the page older than `since` ended the read — no third request.
    const searches = f.calls.filter((c) => c.key.startsWith('POST /v1/search'));
    expect(searches.map((c) => c.body.start_cursor ?? null)).toEqual([null, 'search-2']);
    expect(searches[0]!.body).toMatchObject({ filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' } });
  });

  it('a workspace too busy to read back to `since` over-reports every known page, never under-reports', async () => {
    let n = 0;
    const busy: JiraTransport = async () =>
      json({ object: 'list', has_more: true, next_cursor: `c${n}`, results: [{ object: 'page', id: `0e000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, last_edited_time: '2026-10-22T11:00:00.000Z', parent: { type: 'workspace' } }] });
    const src = notionSource({ transport: busy, limit: noWait });
    const out = await src.changedSince(SITE, R, since, { ...CRED, known: new Set([R, P3]) });
    expect(out.map((p) => p.id).sort()).toEqual([R, P3].sort());
    expect(n).toBe(30);
  });
});
