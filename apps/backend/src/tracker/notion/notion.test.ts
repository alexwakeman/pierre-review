// ── NOTION AS AN ISSUE TRACKER (docs/TRACKERS.md § Notion) ─────────────────────────────────────────────
// Pinned here, all against RECORDED-SHAPE answers (./__fixtures__/notion-api.json) — no real Notion call:
//   1. IDENTITY: the database-root fold, ids, the ident, the browse link, the closed provider lists.
//   2. DETECTION: the Unique ID prefix is the allowlist; no mapping → nothing.
//   3. PASTE: Unique-ID links and page links; a page link resolves through the page to its key.
//   4. PROPERTIES: status groups → categories, a select mapping, people, type, criteria.
//   5. BODY: blocks → markdown (headings, lists, to-dos, code, quotes, tables; the rest skipped).
//   6. COMMENTS: newest 20, the bot flag from the user's type.
//   7. CLIENT: spacing, 429 Retry-After honoured without calling, error codes, the headers.
//   8. THE READER end to end; 9. THE SPRINT LIST (current rule + fallback); 10. SETTINGS (token shape,
//   the refusal without a prefixed Unique ID, the mapping → the allowlist, a mapping for another db).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TICKET_COMMENTS_KEPT,
  TRACKER_PROVIDERS_AVAILABLE,
  TRACKER_PROVIDER_FIELDS,
  TRACKER_PROVIDER_LABEL,
  NOTION_NO_PREFIX_MESSAGE,
  NOTION_TOKEN_RE,
  isReadingTrackerProvider,
  notionDatabaseRoot,
  notionId,
  notionMappingProblem,
  notionUrlId,
  parseTicketIdent,
  parseTicketRef,
  siteTicketKeyOfUrl,
  ticketBrowseUrl,
  ticketIdent,
  ticketIdentForLink,
  trackerTicketIdent,
  trackerTicketRow,
  type NotionTrackerMapping,
} from '@pierre-review/shared';
import { JiraFetchError, type JiraTransport, type RawResponse } from '../jira/fetch.js';
import { maybeAdapterFor } from '../registry.js';
import { SPRINT_LISTERS } from '../sprint/read.js';
import type { TrackerCall } from '../types.js';
import { decideRef, notionPageKeys } from '../manual-links.js';
import { mergeTracker, toWorkspaceTrackerSettings, trackerAccessOf, trackerPatchError } from '../settings.js';
import { prepareTrackerCall } from '../calls.js';
import { notionAdapter } from './adapter.js';
import { blocksToMarkdown, richTextMarkdown, type NotionBlock } from './blocks.js';
import { NOTION_MIN_GAP_MS, __setNotionClock, isNotionLimited, notionErrorMessage, notionRequest, retryAfterMs } from './client.js';
import { __clearNotionUsers, fetchNotionTicket, pageStatus, toNotionComments, type NotionPage } from './reader.js';
import { __clearNotionSchemaCache, schemaProperties, schemaRefusal, statusOptionOrder, suggestMapping, type RawDatabase } from './schema.js';
import { fallbackFilter, listNotionSprint, notionStatusOrder, rangeHolds } from '../sprint/notion.js';

const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('./__fixtures__/notion-api.json', import.meta.url)), 'utf8')) as Record<string, unknown>;
const DB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT = `https://www.notion.so/${DB}`;
const DB_URL = `https://www.notion.so/acme/${DB}?v=0123456789abcdef0123456789abcdef`;
const TOKEN = 'ntn_abcdefghijklmnopqrstuvwxyz0123456789';

const MAPPING: NotionTrackerMapping = {
  version: 1,
  databaseId: DB,
  uniqueId: { property: { id: 'u%3Aid', name: 'ID' }, prefix: 'ENG' },
  status: { type: 'status', property: { id: 'st%3A1', name: 'Status' } },
  assignee: { id: 'as%3A1', name: 'Assignee' },
  sprint: {
    kind: 'relation',
    property: { id: 'sp%3A1', name: 'Sprint' },
    sprintDatabaseId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    dateProperty: { id: 'dt%3A1', name: 'Dates' },
  },
  issueType: { id: 'ty%3A1', name: 'Type' },
  criteria: { id: 'ac%3A1', name: 'Acceptance criteria' },
  blockedBy: { id: 'bl%3A1', name: 'Blocked by' },
};

interface Sent {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A transport answering from the fixtures (or an override), recording every request. */
function fakeNotion(overrides: Record<string, RawResponse | ((s: Sent) => RawResponse)> = {}): { transport: JiraTransport; sent: Sent[] } {
  const sent: Sent[] = [];
  const transport: JiraTransport = async (url, headers, _opts, init) => {
    const s: Sent = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      headers,
      body: init?.body != null ? JSON.parse(init.body) : undefined,
    };
    sent.push(s);
    const k = `${s.method} ${s.path}`;
    const o = overrides[k];
    if (o != null) return typeof o === 'function' ? o(s) : o;
    const v = FIX[k];
    if (v == null) return { status: 404, contentType: 'application/json', body: JSON.stringify({ object: 'error', code: 'object_not_found' }) };
    return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(v) };
  };
  return { transport, sent };
}

const callWith = (transport: JiraTransport, notion: NotionTrackerMapping | undefined = MAPPING): TrackerCall => ({
  provider: 'notion',
  apiRoot: ROOT,
  credentials: { email: null, token: TOKEN },
  policy: { cloud: false },
  transport,
  ...(notion != null ? { notion } : {}),
});

// A clock that never really waits: `sleep` moves time.
function fakeClock(start = 1_000_000) {
  let t = start;
  const slept: number[] = [];
  return {
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
    },
    slept,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

beforeEach(() => {
  __setNotionClock(fakeClock().clock);
  __clearNotionSchemaCache();
  __clearNotionUsers();
});
afterEach(() => __setNotionClock(null));

describe('1. identity — the database is the root; the closed provider lists include Notion', () => {
  it('folds a database URL (any spelling) onto https://www.notion.so/<32 hex>', () => {
    expect(notionDatabaseRoot(DB_URL)).toBe(ROOT);
    expect(notionDatabaseRoot(`https://www.notion.so/acme/Engineering-tasks-${DB.toUpperCase()}`)).toBe(ROOT);
    expect(notionDatabaseRoot('https://acme.notion.site/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(ROOT);
    expect(notionDatabaseRoot('https://www.notion.so/acme/Tasks')).toBeNull();
    expect(notionDatabaseRoot(`https://evil.example/${DB}`)).toBeNull();
    expect(notionId(`x${'a'.repeat(33)}`)).toBeNull();
    expect(notionUrlId(`https://www.notion.so/${'1'.repeat(32)}`)).toBe('1'.repeat(32));
  });

  it('builds and parses a Notion ident; the link is Notion’s Unique-ID URL', () => {
    const ident = trackerTicketIdent('notion', ROOT, 'ENG-42');
    expect(ident).toBe(`notion:${ROOT}#ENG-42`);
    expect(parseTicketIdent(ident)).toMatchObject({ provider: 'notion', root: ROOT, key: 'ENG-42' });
    expect(trackerTicketRow(parseTicketIdent(ident) as never)).toEqual({ provider: 'notion', apiRoot: ROOT, issueKey: 'ENG-42' });
    expect(parseTicketIdent('notion:https://www.notion.so/acme#ENG-42')).toBeNull();
    expect(notionAdapter.browseUrl(DB_URL, 'ENG-42')).toBe('https://www.notion.so/ENG-42');
    expect(ticketBrowseUrl({ provider: 'notion', root: ROOT }, 'ENG-42')).toBe('https://www.notion.so/ENG-42');
    // A Notion link names no database: the SPA takes the server's ident (`TicketLink.ident`).
    expect(ticketIdentForLink({ key: 'ENG-42', url: 'https://www.notion.so/ENG-42', provider: 'notion' })).toBeNull();
  });

  it('every closed list over providers has Notion', () => {
    expect(TRACKER_PROVIDERS_AVAILABLE).toContain('notion');
    for (const p of TRACKER_PROVIDERS_AVAILABLE) {
      expect(maybeAdapterFor(p)?.reader, p).toBeDefined();
      expect(SPRINT_LISTERS[p], p).toBeTypeOf('function');
      expect(TRACKER_PROVIDER_FIELDS[p], p).toBeDefined();
      expect(TRACKER_PROVIDER_LABEL[p], p).toBeTypeOf('string');
      expect(isReadingTrackerProvider(p), p).toBe(true);
      const root = p === 'github' ? 'https://github.com/acme/web' : p === 'linear' ? 'https://linear.app/acme' : p === 'notion' ? ROOT : 'https://acme.atlassian.net';
      expect(parseTicketIdent(ticketIdent(p, root, p === 'github' ? '12' : 'ENG-1')), p).not.toBeNull();
    }
  });
});

describe('2. detection — the Unique ID prefix is the allowlist', () => {
  const cfg = { provider: 'notion' as const, baseUrl: DB_URL, projectKeys: ['ENG'], matchScope: 'title_branch' as const };
  it('finds ENG-n in the title and the branch, and nothing else', () => {
    const found = notionAdapter.detect(cfg, { title: 'ENG-42: export invoices (see OPS-3, GPT-4)', headRefName: 'ada/eng-40-invoice-api' });
    expect(found.map((d) => [d.key, d.from])).toEqual([
      ['ENG-42', 'title'],
      ['ENG-40', 'branch'],
    ]);
  });
  it('detects nothing without a mapping (no prefix saved)', () => {
    expect(notionAdapter.detect({ ...cfg, projectKeys: [] }, { title: 'ENG-42 export', headRefName: null })).toEqual([]);
  });
});

describe('3. paste — Unique-ID links, page links', () => {
  it('parses both link shapes; the Unique-ID link matches this database loosely', () => {
    expect(parseTicketRef('https://www.notion.so/eng-42')).toEqual({ kind: 'url', provider: 'notion', root: 'https://www.notion.so', key: 'ENG-42', loose: true });
    expect(parseTicketRef(`https://www.notion.so/acme/Export-invoices-${'1'.repeat(32)}`)).toEqual({ kind: 'notion_page', pageId: '1'.repeat(32) });
    expect(parseTicketRef('https://www.notion.so/acme')).toEqual({ kind: 'invalid' });
    expect(siteTicketKeyOfUrl('https://www.notion.so/ENG-42', { provider: 'notion', root: ROOT })).toBe('ENG-42');
    expect(decideRef('https://www.notion.so/ENG-42', { provider: 'notion', apiRoot: ROOT }, null)).toEqual({ key: 'ENG-42' });
    expect(decideRef('https://www.notion.so/ENG-42', { provider: 'jira', apiRoot: 'https://acme.atlassian.net' }, null)).toMatchObject({ status: 'other_tracker' });
  });

  it('a page link resolves through the page to its Unique ID; another database’s page is refused', async () => {
    const { transport, sent } = fakeNotion();
    const refs = [`https://www.notion.so/acme/Export-${'1'.repeat(32)}`, `https://www.notion.so/${'9'.repeat(32)}`, `https://www.notion.so/${'7'.repeat(32)}`];
    const pages = await notionPageKeys(callWith(transport), refs);
    expect(pages.get('1'.repeat(32))).toEqual({ key: 'ENG-42' });
    expect(pages.get('9'.repeat(32))).toMatchObject({ status: 'other_tracker' });
    expect(pages.get('7'.repeat(32))).toMatchObject({ status: 'not_found' });
    expect(decideRef(refs[0]!, { provider: 'notion', apiRoot: ROOT }, null, pages)).toEqual({ key: 'ENG-42' });
    expect(sent.map((s) => s.path)).toEqual(refs.map((r) => `/v1/pages/${notionUrlId(r)}`));
  });
});

describe('4. properties — status groups, a select mapping, the schema', () => {
  const db = FIX[`GET /v1/databases/${DB}`] as RawDatabase;
  const page = (FIX[`POST /v1/databases/${DB}/query`] as { results: NotionPage[] }).results[0]!;

  it('orders a status property by group (To-do → In progress → Complete) with categories', () => {
    expect(statusOptionOrder(db.properties!.Status!.status).map((o) => [o.name, o.category])).toEqual([
      ['Not started', 'new'],
      ['In progress', 'indeterminate'],
      ['In review', 'indeterminate'],
      ['Done', 'done'],
    ]);
    const groups = statusOptionOrder(db.properties!.Status!.status);
    expect(pageStatus(page, MAPPING, groups)).toEqual({ name: 'In review', category: 'indeterminate', id: 'o-review' });
  });

  it('a select status takes the mapped category; an unmapped option is To do', () => {
    const m: NotionTrackerMapping = { ...MAPPING, status: { type: 'select', property: { id: 'ty%3A1', name: 'Type' }, options: { Story: 'done' } } };
    expect(pageStatus(page, m, null)).toEqual({ name: 'Story', category: 'done', id: 't1' });
    const m2: NotionTrackerMapping = { ...m, status: { type: 'select', property: m.status!.property, options: {} } };
    expect(pageStatus(page, m2, null)?.category).toBe('new');
  });

  it('lists the schema, suggests a mapping, and REFUSES a database with no prefixed Unique ID', () => {
    const props = schemaProperties(db);
    expect(props.find((p) => p.type === 'unique_id')?.prefix).toBe('ENG');
    expect(schemaRefusal(props)).toBeNull();
    const s = suggestMapping(DB, props, {
      'sp%3A1': { databaseId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'Sprints', dateProperties: [{ id: 'dt%3A1', name: 'Dates' }] },
    });
    expect(s).toEqual(MAPPING);
    const noPrefix = props.map((p) => (p.type === 'unique_id' ? { ...p, prefix: '' } : p));
    expect(schemaRefusal(noPrefix)).toBe(NOTION_NO_PREFIX_MESSAGE);
    expect(suggestMapping(DB, noPrefix, {})).toBeNull();
    expect(schemaRefusal(props.filter((p) => p.type !== 'unique_id'))).toBe(NOTION_NO_PREFIX_MESSAGE);
  });
});

describe('5. body — blocks → markdown', () => {
  it('draws the supported blocks and skips the rest', () => {
    const blocks: NotionBlock[] = [
      { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Goal' }] } },
      { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'See ' }, { plain_text: 'docs', href: 'https://docs.example/x' }, { plain_text: ' and ' }, { plain_text: 'run()', annotations: { code: true } }] } },
      { type: 'numbered_list_item', numbered_list_item: { rich_text: [{ plain_text: 'one' }] } },
      { type: 'numbered_list_item', numbered_list_item: { rich_text: [{ plain_text: 'two' }] }, children: [{ type: 'to_do', to_do: { rich_text: [{ plain_text: 'sub' }], checked: true } }] },
      { type: 'to_do', to_do: { rich_text: [{ plain_text: 'Ship it' }], checked: false } },
      { type: 'code', code: { rich_text: [{ plain_text: 'SELECT 1;' }], language: 'sql' } },
      { type: 'quote', quote: { rich_text: [{ plain_text: 'Keep it short' }] } },
      { type: 'callout', callout: { rich_text: [{ plain_text: 'Heads up', annotations: { italic: true } }] } },
      { type: 'table', children: [
        { type: 'table_row', table_row: { cells: [[{ plain_text: 'A' }], [{ plain_text: 'B|C' }]] } },
        { type: 'table_row', table_row: { cells: [[{ plain_text: '1' }], [{ plain_text: '2' }]] } },
      ] },
      { type: 'divider', divider: {} },
      { type: 'image', image: {} },
      { type: 'child_database', child_database: {} },
    ];
    expect(blocksToMarkdown(blocks)).toBe(
      [
        '# Goal',
        'See [docs](https://docs.example/x) and `run()`',
        '1. one\n2. two\n  - [x] sub\n- [ ] Ship it',
        '```sql\nSELECT 1;\n```',
        '> Keep it short',
        '> *Heads up*',
        '| A | B\\|C |\n| --- | --- |\n| 1 | 2 |',
        '---',
      ].join('\n\n'),
    );
  });
  it('never links a non-https href', () => {
    expect(richTextMarkdown([{ plain_text: 'x', href: 'javascript:alert(1)' }])).toBe('x');
  });
});

describe('6. comments — the newest 20, bots flagged by the user’s type', () => {
  it('keeps the newest and flags bots', async () => {
    const raw = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`,
      created_time: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
      created_by: { id: i === 24 ? 'bot' : 'person' },
      rich_text: [{ plain_text: `n${i}` }],
    }));
    const out = await toNotionComments(raw, async (id) => (id === 'bot' ? { name: 'Zap', isBot: true } : { name: 'Dana Lee', isBot: false }));
    expect(out).toHaveLength(TICKET_COMMENTS_KEPT);
    expect(out[0]!.id).toBe('c5');
    expect(out.at(-1)).toMatchObject({ id: 'c24', isBot: true, authorName: 'Zap' });
    expect(out[0]).toMatchObject({ isBot: false, authorName: 'Dana Lee', body: 'n5' });
  });
});

describe('7. client — ≈3 requests a second, 429 Retry-After, our own error codes', () => {
  it('spaces calls with one token by NOTION_MIN_GAP_MS and sends the pinned version + Bearer', async () => {
    const c = fakeClock();
    __setNotionClock(c.clock);
    const { transport, sent } = fakeNotion();
    const call = callWith(transport);
    await Promise.all([1, 2, 3].map(() => notionRequest(call, 'GET', `/v1/databases/${DB}`)));
    // The fake sleep moves the clock at once, so each later call waits one gap past the one before.
    expect(c.slept).toEqual([NOTION_MIN_GAP_MS, NOTION_MIN_GAP_MS]);
    expect(c.clock.now() - 1_000_000).toBe(NOTION_MIN_GAP_MS * 2);
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]!.headers['notion-version']).toBe('2022-06-28');
  });

  it('a 429 records Retry-After; every call before it is refused WITHOUT calling', async () => {
    const c = fakeClock();
    __setNotionClock(c.clock);
    const { transport, sent } = fakeNotion({
      [`GET /v1/databases/${DB}`]: { status: 429, contentType: 'application/json', body: '{}', headers: { 'retry-after': '30' } },
    });
    const call = callWith(transport);
    await expect(notionRequest(call, 'GET', `/v1/databases/${DB}`)).rejects.toMatchObject({ code: 'http', status: 429 });
    expect(isNotionLimited(TOKEN)).toBe(true);
    await expect(notionRequest(call, 'GET', `/v1/databases/${DB}`)).rejects.toMatchObject({ status: 429 });
    expect(sent).toHaveLength(1);
    c.advance(31_000);
    expect(isNotionLimited(TOKEN)).toBe(false);
    expect(retryAfterMs({ 'retry-after': 'soon' })).toBe(60_000);
    expect(retryAfterMs({ 'retry-after': '99999' })).toBe(15 * 60_000);
    expect(notionErrorMessage(new JiraFetchError('http', 429))).toMatch(/rate limit/);
  });

  it('maps 401 / 403 / 404 / a redirect to our codes, never Notion’s body', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [302, 'redirect'],
      [500, 'http'],
    ] as const) {
      const { transport } = fakeNotion({ [`GET /v1/databases/${DB}`]: { status, contentType: 'application/json', body: '{"message":"secret detail"}' } });
      const err = await notionRequest(callWith(transport), 'GET', `/v1/databases/${DB}`).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JiraFetchError);
      expect((err as JiraFetchError).code).toBe(code);
      expect(notionErrorMessage(err)).not.toContain('secret');
    }
  });
});

describe('8. the reader — one ticket, end to end', () => {
  it('queries by the Unique ID number and reads properties, body, blockers and comments', async () => {
    const { transport, sent } = fakeNotion();
    const t = await fetchNotionTicket(callWith(transport), 'ENG-42');
    expect(sent[0]).toMatchObject({ method: 'POST', path: `/v1/databases/${DB}/query`, body: { filter: { property: 'u%3Aid', unique_id: { equals: 42 } }, page_size: 1 } });
    expect(t).toMatchObject({
      key: 'ENG-42',
      title: 'Export invoices as CSV',
      issueType: { id: 't1', name: 'Story' },
      status: { name: 'In review', category: 'indeterminate', id: 'o-review' },
      assignee: { name: 'Ada Lovelace', accountId: 'user-ada', avatarUrl: 'https://s3.example/ada.png' },
      url: 'https://www.notion.so/acme/Export-invoices-as-CSV-11111111111111111111111111111111',
      candidates: [{ id: 'notion:property', name: 'Acceptance criteria', match: 'strong' }],
    });
    expect(t.description).toBe('## Why\n\nFinance needs a **monthly** export.\n\n- One row per invoice\n  - Totals in the footer');
    expect(t.issueCreatedAt?.toISOString()).toBe('2026-10-20T09:00:00.000Z');
    expect(t.issueResolvedAt).toBeUndefined();
    expect(t.blockedBy).toEqual([
      { key: 'ENG-40', title: 'Invoice API', status: 'In progress', category: 'indeterminate', relation: 'blocked by', url: 'https://www.notion.so/acme/Invoice-API-33333333333333333333333333333333' },
    ]);
    expect(t.comments?.map((c) => [c.id, c.authorName, c.isBot, c.body])).toEqual([
      ['c1', 'Dana Lee', false, 'Drop the PDF option, CSV only.'],
      ['c2', 'Slack sync', true, 'Synced from Slack.'],
    ]);
    // Nothing writes: every call is a GET or a database QUERY.
    expect(sent.every((s) => s.method === 'GET' || s.path.endsWith('/query'))).toBe(true);
  });

  it('another prefix is not this database’s; a missing page is not_found; a refused comment read is UNKNOWN', async () => {
    const { transport } = fakeNotion({
      [`POST /v1/databases/${DB}/query`]: { status: 200, contentType: 'application/json', body: '{"results":[]}' },
    });
    await expect(fetchNotionTicket(callWith(transport), 'OPS-1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(fetchNotionTicket(callWith(transport), 'ENG-7')).rejects.toMatchObject({ code: 'not_found' });
    const refused = fakeNotion({ 'GET /v1/comments': { status: 403, contentType: 'application/json', body: '{}' } });
    const t = await fetchNotionTicket(callWith(refused.transport), 'ENG-42');
    expect(t.comments).toBeUndefined();
  });

  it('no criteria property: the shared rule finds a task list in the body', async () => {
    const { transport } = fakeNotion({
      [`GET /v1/blocks/11111111-1111-1111-1111-111111111111/children`]: {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Do it.' }] } }, { type: 'to_do', to_do: { rich_text: [{ plain_text: 'CSV' }], checked: false } }] }),
      },
    });
    const t = await fetchNotionTicket(callWith(transport, { ...MAPPING, criteria: null, blockedBy: null }), 'ENG-42');
    expect(t.candidates).toEqual([expect.objectContaining({ id: 'notion:task_list', text: '- [ ] CSV' })]);
    expect(t.description).toBe('Do it.');
    expect(t.blockedBy).toBeNull();
  });

  it('a call with no mapping is a settings problem', async () => {
    const { transport } = fakeNotion();
    const { notion: _drop, ...unmapped } = callWith(transport);
    await expect(fetchNotionTicket(unmapped, 'ENG-42')).rejects.toMatchObject({ code: 'bad_url' });
  });
});

describe('9. the sprint list — the current rule and the fallback', () => {
  const window = { fromMs: Date.parse('2026-10-14T00:00:00Z'), toMs: Date.parse('2026-10-28T12:00:00Z') };
  const args = (transport: JiraTransport, m: NotionTrackerMapping = MAPPING) => ({
    call: callWith(transport, m),
    projectKeys: ['ENG'],
    repos: [],
    fallbackWindow: window,
    acSettingFor: () => null,
  });

  it('a range holds a day from start to end; no end is that day', () => {
    expect(rangeHolds({ start: '2026-10-19', end: '2026-11-01' }, '2026-10-28')).toBe(true);
    expect(rangeHolds({ start: '2026-10-28' }, '2026-10-28')).toBe(true);
    expect(rangeHolds({ start: '2026-10-05', end: '2026-10-18' }, '2026-10-28')).toBe(false);
    expect(rangeHolds(null, '2026-10-28')).toBe(false);
  });

  it('relation: the Sprints page whose dates hold today; its tickets, name, dates and status order', async () => {
    const { transport, sent } = fakeNotion();
    const r = await listNotionSprint(args(transport));
    const sprintQuery = sent.find((s) => s.path === '/v1/databases/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/query')!;
    expect(sprintQuery.body).toMatchObject({ filter: { property: 'dt%3A1', date: { on_or_before: '2026-10-28' } } });
    const ticketQuery = sent.filter((s) => s.path === `/v1/databases/${DB}/query`)[0]!;
    expect(ticketQuery.body).toMatchObject({ filter: { property: 'sp%3A1', relation: { contains: '22222222-2222-2222-2222-222222222222' } } });
    expect(r.source).toEqual({ kind: 'sprint', provider: 'notion', names: ['Sprint 14'] });
    expect(r.tickets.map((t) => [t.key, t.sprintName, t.projectKey, t.status?.category])).toEqual([['ENG-42', 'Sprint 14', 'ENG', 'indeterminate']]);
    expect(r.dates?.startsAt?.toISOString().slice(0, 10)).toBe('2026-10-19');
    expect(r.dates?.endsAt?.toISOString().slice(0, 10)).toBe('2026-11-01');
    expect(r.statusOrder?.source).toBe('notion_status');
    expect(r.statusOrder?.statuses.map((s) => s.name)).toEqual(['Not started', 'In progress', 'In review', 'Done']);
  });

  it('nothing current → the status fallback (To-do + In progress, edited in the window)', async () => {
    const { transport, sent } = fakeNotion({
      'POST /v1/databases/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/query': { status: 200, contentType: 'application/json', body: '{"results":[]}' },
    });
    const r = await listNotionSprint(args(transport));
    expect(r.source).toMatchObject({ kind: 'status_fallback', provider: 'notion', reason: 'none_active' });
    const q = sent.filter((s) => s.path === `/v1/databases/${DB}/query`)[0]!;
    expect(q.body).toMatchObject({
      filter: {
        and: [
          { timestamp: 'last_edited_time', last_edited_time: { on_or_after: '2026-10-14T00:00:00.000Z' } },
          { or: [{ property: 'st%3A1', status: { equals: 'Not started' } }, { property: 'st%3A1', status: { equals: 'In progress' } }, { property: 'st%3A1', status: { equals: 'In review' } }] },
        ],
      },
    });
    const none = await listNotionSprint(args(fakeNotion().transport, { ...MAPPING, sprint: null }));
    expect(none.source).toMatchObject({ kind: 'status_fallback', reason: 'no_sprint_concept' });
  });

  it('select: the chosen option; select status order sorts by the mapped category', async () => {
    const { transport, sent } = fakeNotion();
    const m: NotionTrackerMapping = { ...MAPPING, sprint: { kind: 'select', property: { id: 'ty%3A1', name: 'Type' }, current: 'Story' } };
    const r = await listNotionSprint(args(transport, m));
    expect(sent.find((s) => s.path === `/v1/databases/${DB}/query`)!.body).toMatchObject({ filter: { property: 'ty%3A1', select: { equals: 'Story' } } });
    expect(r.source).toEqual({ kind: 'sprint', provider: 'notion', names: ['Story'] });
    const db = FIX[`GET /v1/databases/${DB}`] as RawDatabase;
    const order = notionStatusOrder(db, { ...MAPPING, status: { type: 'select', property: { id: 'ty%3A1', name: 'Type' }, options: { Story: 'done', Bug: 'new' } } }, 'x');
    expect(order?.statuses.map((s) => [s.name, s.category])).toEqual([
      ['Bug', 'new'],
      ['Story', 'done'],
    ]);
    expect(fallbackFilter({ ...MAPPING, status: null }, db, 'X')).toEqual({ timestamp: 'last_edited_time', last_edited_time: { on_or_after: 'X' } });
  });
});

describe('10. settings — token shape, the mapping, the refusal', () => {
  it('shape-checks the token', () => {
    expect(NOTION_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(NOTION_TOKEN_RE.test(`secret_${'abcd'}efghijklmnopqrstuvwxyz0123456789ABC`)).toBe(true);
    expect(NOTION_TOKEN_RE.test('lin_api_abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(trackerPatchError(null, { issue: { provider: 'notion', baseUrl: DB_URL }, jira: { token: 'ghp_abcdefghijklmnopqrstuvwxyz' } })).toMatch(/Notion integration token/);
    expect(trackerPatchError(null, { issue: { provider: 'notion', baseUrl: DB_URL }, jira: { token: TOKEN } })).toBeNull();
  });

  it('refuses a mapping without a prefixed Unique ID, or for another database', () => {
    const noPrefix = { ...MAPPING, uniqueId: { ...MAPPING.uniqueId, prefix: '' } };
    expect(notionMappingProblem(noPrefix)).toBe(NOTION_NO_PREFIX_MESSAGE);
    const row = { provider: 'notion', baseUrl: DB_URL, projectKeys: null, matchScope: null, authEmail: null, authToken: null };
    expect(trackerPatchError(row, { notion: noPrefix })).toBe(NOTION_NO_PREFIX_MESSAGE);
    expect(trackerPatchError(row, { notion: { ...MAPPING, databaseId: 'c'.repeat(32) } })).toMatch(/different database/);
    expect(trackerPatchError(row, { notion: MAPPING })).toBeNull();
    expect(notionMappingProblem({ ...MAPPING, status: { type: 'select', property: MAPPING.status!.property, options: { A: 'later' } } })).toMatch(/status options/);
  });

  it('a saved mapping becomes the allowlist; another database drops it; it reaches the call', () => {
    const saved = mergeTracker(null, { issue: { provider: 'notion', baseUrl: DB_URL }, notion: MAPPING });
    expect(saved.projectKeys).toBe('ENG');
    expect(JSON.parse(saved.notionConfig!)).toEqual(MAPPING);
    // The prefix wins over any key list typed for another provider.
    expect(mergeTracker(saved, { issue: { projectKeys: ['OPS'] } }).projectKeys).toBe('ENG');
    const moved = mergeTracker({ ...saved, authToken: 'plain:x' }, { issue: { baseUrl: `https://www.notion.so/${'c'.repeat(32)}` } });
    expect(moved.notionConfig).toBeNull();
    expect(moved.projectKeys).toBeNull();
    // The token is the integration's, not the database's: it stays.
    expect(moved.authToken).toBe('plain:x');
    expect(toWorkspaceTrackerSettings(1, saved).notion).toEqual(MAPPING);

    const access = trackerAccessOf(undefined, { ...saved, authToken: `plain:${TOKEN}` });
    const ok = prepareTrackerCall(access, {});
    expect(ok.ok && ok.call.notion).toEqual(MAPPING);
    const unmapped = prepareTrackerCall(trackerAccessOf(undefined, { ...saved, notionConfig: null, authToken: `plain:${TOKEN}` }), {});
    expect(unmapped).toMatchObject({ ok: false, error: 'NoNotionMapping' });
    expect(prepareTrackerCall(trackerAccessOf(undefined, { ...saved, notionConfig: null, authToken: `plain:${TOKEN}` }), { allowUnmapped: true }).ok).toBe(true);
  });
});
