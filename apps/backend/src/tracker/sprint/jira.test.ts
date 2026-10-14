// Jira's sprint list (./jira.ts): the request shape (v3 enhanced search through the one outbound
// helper, quoted project keys, `expand=names,schema`), the active sprint's names, the issue fold
// (criteria candidates, epic, components, project), the two fallbacks (400 → no_sprint_concept,
// 0 issues → none_active), `nextPageToken` paging, the 150 cap, and the Server / DC v2 retry.
// No request leaves the process: every answer comes from the fake transport.
import { describe, expect, it } from 'vitest';
import { SPRINT_TICKETS_MAX } from '@pierre-review/shared';
import { JiraFetchError, type JiraTransport, type RawResponse } from '../jira/fetch.js';
import type { TrackerCall } from '../types.js';
import { blockedByOf, statusOf } from '../jira/client.js';
import {
  boardStatusIds,
  busiestBoard,
  fallbackJql,
  jiraBoardOrder,
  listJiraSprint,
  sprintJql,
  sprintsOf,
  statusCatalog,
  toJiraSprintTicket,
} from './jira.js';

const ROOT = 'https://acme.atlassian.net';
const json = (body: unknown, status = 200): RawResponse => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const NAMES = { summary: 'Summary', customfield_10020: 'Sprint', customfield_10050: 'Acceptance Criteria', customfield_10014: 'Epic Link' };
const SCHEMA = {
  customfield_10020: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
  customfield_10050: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' },
  customfield_10014: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-epic-link' },
};

function issue(n: number, over: Record<string, unknown> = {}) {
  return {
    key: `ENG-${n}`,
    fields: {
      summary: `Story ${n}`,
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `Body ${n}` }] }] },
      issuetype: { id: '10001', name: 'Story' },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      assignee: null,
      project: { key: 'ENG' },
      components: [{ name: 'Billing' }],
      updated: '2026-10-01T10:00:00.000+0000',
      created: '2026-09-20T10:00:00.000+0000',
      customfield_10020: [
        { id: 1, name: 'Sprint 41', state: 'closed' },
        { id: 2, name: 'Sprint 42', state: 'active' },
      ],
      customfield_10050: '* The user sees the invoice',
      ...over,
    },
  };
}

function call(transport: JiraTransport): TrackerCall {
  return { provider: 'jira', apiRoot: ROOT, credentials: { email: 'me@acme.com', token: 'tok' }, policy: { cloud: false }, transport };
}

const args = (transport: JiraTransport, projectKeys = ['ENG']) => ({
  call: call(transport),
  projectKeys,
  repos: [],
  fallbackWindow: { fromMs: Date.UTC(2026, 8, 26, 9, 5), toMs: Date.UTC(2026, 9, 10) },
  acSettingFor: () => null,
});

describe('JQL', () => {
  it('quotes the project keys and drops malformed ones', () => {
    expect(sprintJql(['ENG', 'OPS', 'bad key"'])).toBe('project in ("ENG","OPS") AND sprint in openSprints() ORDER BY rank');
    expect(() => sprintJql(['"; DROP'])).toThrow(JiraFetchError);
  });
  it('the fallback reads To do + In progress touched since the window start (a relative duration, time-zone free)', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0);
    expect(fallbackJql(['ENG'], now - 14 * 86_400_000 - 30_000, now)).toBe(
      'project in ("ENG") AND statusCategory in ("To Do","In Progress") AND updated >= -20161m ORDER BY updated DESC',
    );
  });
});

describe('sprint field values', () => {
  it('reads Cloud objects and old Server strings', () => {
    expect(sprintsOf([{ name: 'S1', state: 'ACTIVE' }])).toEqual([{ name: 'S1', state: 'active', boardId: null, startsAt: null, endsAt: null }]);
    expect(sprintsOf([{ name: 'S2', state: 'active', boardId: 12 }])).toEqual([{ name: 'S2', state: 'active', boardId: 12, startsAt: null, endsAt: null }]);
    expect(sprintsOf(['com.atlassian.greenhopper.service.sprint.Sprint@1a[id=3,rapidViewId=1,state=ACTIVE,name=Sprint 7,startDate=x]'])).toEqual([
      { name: 'Sprint 7', state: 'active', boardId: 1, startsAt: null, endsAt: null },
    ]);
    expect(sprintsOf(null)).toEqual([]);
  });

  it('reads the sprint dates: Cloud startDate/endDate, Server strings (with <null>)', () => {
    expect(
      sprintsOf([{ name: 'Sprint 15 (Oct 14-27)', state: 'active', boardId: 4, startDate: '2026-10-14T10:15:35.000Z', endDate: '2026-10-27T17:00:00.000Z' }]),
    ).toEqual([
      { name: 'Sprint 15 (Oct 14-27)', state: 'active', boardId: 4, startsAt: new Date('2026-10-14T10:15:35.000Z'), endsAt: new Date('2026-10-27T17:00:00.000Z') },
    ]);
    const [server] = sprintsOf([
      'com.atlassian.greenhopper.service.sprint.Sprint@1a[id=3,rapidViewId=1,state=ACTIVE,name=Sprint 7,startDate=2015-04-08T12:00:00.000+02:00,endDate=<null>,completeDate=<null>,sequence=3]',
    ]);
    expect(server!.startsAt?.toISOString()).toBe('2015-04-08T10:00:00.000Z');
    expect(server!.endsAt).toBeNull();
    expect(sprintsOf([{ name: 'S', state: 'active', startDate: 'not a date', endDate: '' }])[0]).toMatchObject({ startsAt: null, endsAt: null });
  });
});

describe('the issue fold', () => {
  it('maps title, ADF description, criteria candidates, status, project, components, sprint, epic', () => {
    const t = toJiraSprintTicket(issue(1, { parent: { key: 'ENG-100', fields: { summary: 'Billing', issuetype: { name: 'Epic' } } } }), NAMES, SCHEMA, true)!;
    expect(t.key).toBe('ENG-1');
    expect(t.title).toBe('Story 1');
    expect(t.description).toContain('Body 1');
    expect(t.status).toEqual({ name: 'To Do', category: 'new' });
    expect(t.projectKey).toBe('ENG');
    expect(t.components).toEqual(['Billing']);
    expect(t.sprintName).toBe('Sprint 42');
    expect(t.epic).toEqual({ key: 'ENG-100', title: 'Billing' });
    expect(t.candidates.map((c) => c.id)).toContain('customfield_10050');
    expect(t.issueUpdatedAt?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });
  it('falls back to the Epic Link field, and leaves components null when not read', () => {
    const t = toJiraSprintTicket(issue(2, { customfield_10014: 'ENG-7', components: undefined }), NAMES, SCHEMA, true)!;
    expect(t.epic).toEqual({ key: 'ENG-7', title: null });
    expect(t.components).toBeNull();
  });
  it('a fallback ticket carries no sprint name; a malformed key is dropped', () => {
    expect(toJiraSprintTicket(issue(3), NAMES, SCHEMA, false)!.sprintName).toBeNull();
    expect(toJiraSprintTicket({ key: 'nope', fields: {} }, NAMES, SCHEMA, true)).toBeNull();
  });
});

describe('blocking links (issuelinks)', () => {
  const link = (type: Record<string, string>, side: 'inwardIssue' | 'outwardIssue', key: string, status = 'To Do', cat = 'new') => ({
    type,
    [side]: { key, fields: { summary: `Title ${key}`, status: { id: '1', name: status, statusCategory: { key: cat } } } },
  });
  const BLOCKS = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
  const DEPENDS = { name: 'Dependency', inward: 'is depended on by', outward: 'depends on' };
  const RELATES = { name: 'Relates', inward: 'relates to', outward: 'relates to' };

  it('reads the phrase from THIS ticket’s side: inward issue → type.inward, outward → type.outward', () => {
    const got = blockedByOf(
      [
        link(BLOCKS, 'inwardIssue', 'ENG-2'), // this ticket "is blocked by" ENG-2 → kept
        link(BLOCKS, 'outwardIssue', 'ENG-3'), // this ticket "blocks" ENG-3 → dropped
        link(DEPENDS, 'outwardIssue', 'ENG-4', 'Done', 'done'), // "depends on" ENG-4 → kept (resolved)
        link(DEPENDS, 'inwardIssue', 'ENG-5'), // "is depended on by" → dropped
        link(RELATES, 'inwardIssue', 'ENG-6'),
        link(BLOCKS, 'inwardIssue', 'ENG-2'), // duplicate
        { type: BLOCKS }, // no issue
      ],
      ROOT,
    );
    expect(got).toEqual([
      { key: 'ENG-2', title: 'Title ENG-2', status: 'To Do', category: 'new', relation: 'is blocked by', url: `${ROOT}/browse/ENG-2` },
      { key: 'ENG-4', title: 'Title ENG-4', status: 'Done', category: 'done', relation: 'depends on', url: `${ROOT}/browse/ENG-4` },
    ]);
  });

  it('absent field → undefined (not in the answer); present and none → []; an http root gives no url', () => {
    expect(blockedByOf(undefined, ROOT)).toBeUndefined();
    expect(blockedByOf([], ROOT)).toEqual([]);
    expect(blockedByOf([link(BLOCKS, 'inwardIssue', 'ENG-2')], 'http://jira.local')?.[0]?.url).toBeNull();
  });

  it('the sprint fold carries the links and the status id', () => {
    const t = toJiraSprintTicket(
      issue(7, { issuelinks: [link(BLOCKS, 'inwardIssue', 'ENG-2')], status: { id: '10003', name: 'In Dev', statusCategory: { key: 'indeterminate' } } }),
      NAMES,
      SCHEMA,
      true,
      ROOT,
    )!;
    expect(t.blockedBy?.map((b) => b.key)).toEqual(['ENG-2']);
    expect(t.status).toEqual({ name: 'In Dev', category: 'indeterminate', id: '10003' });
    // No issuelinks field at all: the key is absent, so the stored links stand.
    expect('blockedBy' in toJiraSprintTicket(issue(8), NAMES, SCHEMA, true, ROOT)!).toBe(false);
    expect(statusOf({ name: 'X', id: 5 })).toEqual({ name: 'X', category: null, id: '5' });
  });
});

describe('the board order', () => {
  const CONFIG = {
    columnConfig: {
      columns: [
        { name: 'To Do', statuses: [{ id: '1' }] },
        { name: 'Doing', statuses: [{ id: '3' }, { id: '10100' }] },
        { name: 'Review', statuses: [{ id: '10200' }, { id: '3' }] },
        { name: 'Done', statuses: [{ id: '10001' }, { id: '999' }] },
      ],
    },
  };
  const STATUSES = [
    { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
    { id: '3', name: 'In Development', statusCategory: { key: 'indeterminate' } },
    { id: '10100', name: 'Ready for QA', statusCategory: { key: 'indeterminate' } },
    { id: '10200', name: 'In PO Review', statusCategory: { key: 'indeterminate' } },
    { id: '10001', name: 'Done', statusCategory: { key: 'done' } },
  ];

  it('maps column status ids to names in column order; unknown ids dropped; duplicates once', () => {
    expect(boardStatusIds(CONFIG)).toEqual(['1', '3', '10100', '10200', '10001', '999']);
    const o = jiraBoardOrder(boardStatusIds(CONFIG), statusCatalog(STATUSES), 'T');
    expect(o).toEqual({
      source: 'jira_board',
      readAt: 'T',
      statuses: [
        { id: '1', name: 'To Do', category: 'new' },
        { id: '3', name: 'In Development', category: 'indeterminate' },
        { id: '10100', name: 'Ready for QA', category: 'indeterminate' },
        { id: '10200', name: 'In PO Review', category: 'indeterminate' },
        { id: '10001', name: 'Done', category: 'done' },
      ],
    });
    expect(jiraBoardOrder(['999'], statusCatalog(STATUSES), 'T')).toBeNull();
    expect(boardStatusIds({})).toEqual([]);
  });

  it('picks the busiest board, ties to the lowest id', () => {
    expect(busiestBoard(new Map([[7, 2], [3, 5], [9, 5]]))).toBe(3);
    expect(busiestBoard(new Map())).toBeNull();
  });

  const withBoard = (n: number, boardId: number) =>
    issue(n, { customfield_10020: [{ id: 2, name: 'Sprint 42', state: 'active', boardId }] });

  it('the list read reads the busiest board’s configuration and the status catalog', async () => {
    const paths: string[] = [];
    const t: JiraTransport = async (url) => {
      paths.push(url.pathname);
      if (url.pathname === '/rest/agile/1.0/board/5/configuration') return json(CONFIG);
      if (url.pathname === '/rest/api/2/status') return json(STATUSES);
      return json({ issues: [withBoard(1, 5), withBoard(2, 5), withBoard(3, 8)], names: NAMES, schema: SCHEMA, isLast: true });
    };
    const r = await listJiraSprint(args(t));
    expect(paths).toEqual(['/rest/api/3/search/jql', '/rest/agile/1.0/board/5/configuration', '/rest/api/2/status']);
    expect(r.statusOrder?.statuses.map((s) => s.name)).toEqual(['To Do', 'In Development', 'Ready for QA', 'In PO Review', 'Done']);
    expect(r.statusOrderError).toBeUndefined();
  });

  it('a failed board read never fails the list: statusOrder undefined (keep stored) + the code', async () => {
    const t: JiraTransport = async (url) =>
      url.pathname.includes('/agile/') ? json({}, 403) : json({ issues: [withBoard(1, 5)], names: NAMES, schema: SCHEMA, isLast: true });
    const r = await listJiraSprint(args(t));
    expect(r.tickets).toHaveLength(1);
    expect(r.statusOrder).toBeUndefined();
    expect(r.statusOrderError).toBe('forbidden');
  });

  it('the list carries the BUSIEST active sprint\'s dates', async () => {
    const sp = (n: number, name: string, startDate: string, endDate: string) =>
      issue(n, { customfield_10020: [{ id: n, name, state: 'active', boardId: 5, startDate, endDate }] });
    const t: JiraTransport = async (url) =>
      url.pathname.includes('/agile/') || url.pathname.includes('/status')
        ? json({}, 403)
        : json({
            issues: [sp(1, 'Small', '2026-10-01T09:00:00Z', '2026-10-15T09:00:00Z'), sp(2, 'Big', '2026-10-14T09:00:00Z', '2026-10-28T09:00:00Z'), sp(3, 'Big', '2026-10-14T09:00:00Z', '2026-10-28T09:00:00Z')],
            names: NAMES,
            schema: SCHEMA,
            isLast: true,
          });
    const r = await listJiraSprint(args(t));
    expect(r.dates).toEqual({ startsAt: new Date('2026-10-14T09:00:00Z'), endsAt: new Date('2026-10-28T09:00:00Z') });
  });

  it('no board on the sprint objects, or the status fallback → null', async () => {
    const t: JiraTransport = async () => json({ issues: [issue(1)], names: NAMES, schema: SCHEMA, isLast: true });
    expect((await listJiraSprint(args(t))).statusOrder).toBeNull();
  });
});

describe('listJiraSprint', () => {
  it('reads the open sprint through v3 search/jql with the auth header and names its sprints', async () => {
    const seen: Array<{ url: URL; headers: Record<string, string>; method: string | undefined }> = [];
    const t: JiraTransport = async (url, headers, _o, init) => {
      seen.push({ url, headers, method: init?.method });
      return json({ issues: [issue(1), issue(2)], names: NAMES, schema: SCHEMA, isLast: true });
    };
    const r = await listJiraSprint(args(t));
    expect(r.source).toEqual({ kind: 'sprint', provider: 'jira', names: ['Sprint 42'] });
    expect(r.dates).toBeNull(); // the fixture's sprint objects carry no dates
    expect(r.tickets.map((x) => x.key)).toEqual(['ENG-1', 'ENG-2']);
    expect(r.truncated).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBeUndefined(); // a GET
    expect(seen[0]!.url.pathname).toBe('/rest/api/3/search/jql');
    expect(seen[0]!.url.searchParams.get('jql')).toBe(sprintJql(['ENG']));
    expect(seen[0]!.url.searchParams.get('fields')).toBe('*all');
    expect(seen[0]!.url.searchParams.get('expand')).toBe('names,schema');
    expect(seen[0]!.headers.authorization).toMatch(/^Basic /);
  });

  it('a 400 (no sprint field) falls back to the status read, no_sprint_concept', async () => {
    const jqls: string[] = [];
    const t: JiraTransport = async (url) => {
      const jql = url.searchParams.get('jql') ?? '';
      jqls.push(jql);
      if (jql.includes('openSprints')) return json({ errorMessages: ['Field sprint does not exist'] }, 400);
      return json({ issues: [issue(5)], names: NAMES, schema: SCHEMA, isLast: true });
    };
    const r = await listJiraSprint(args(t));
    expect(r.source).toMatchObject({ kind: 'status_fallback', provider: 'jira', reason: 'no_sprint_concept' });
    expect(r.source.kind === 'status_fallback' && r.source.from).toBe('2026-09-26T09:05:00.000Z');
    expect(jqls[1]).toContain('statusCategory in ("To Do","In Progress")');
    expect(r.tickets[0]!.sprintName).toBeNull();
  });

  it('no issues in an open sprint falls back with none_active', async () => {
    const t: JiraTransport = async (url) =>
      (url.searchParams.get('jql') ?? '').includes('openSprints') ? json({ issues: [], isLast: true }) : json({ issues: [issue(9)], isLast: true });
    const r = await listJiraSprint(args(t));
    expect(r.source).toMatchObject({ kind: 'status_fallback', reason: 'none_active' });
    expect(r.tickets).toHaveLength(1);
  });

  it('pages with nextPageToken and cuts at the cap (truncated)', async () => {
    const tokens: Array<string | null> = [];
    const t: JiraTransport = async (url) => {
      const tok = url.searchParams.get('nextPageToken');
      tokens.push(tok);
      const page = tok == null ? 0 : Number(tok);
      const issues = Array.from({ length: 100 }, (_, i) => issue(page * 100 + i + 1));
      return json({ issues, names: NAMES, schema: SCHEMA, nextPageToken: String(page + 1), isLast: false });
    };
    const r = await listJiraSprint(args(t));
    expect(tokens).toEqual([null, '1']);
    expect(r.tickets).toHaveLength(SPRINT_TICKETS_MAX);
    expect(r.truncated).toBe(true);
  });

  it('a Server / DC site (no v3 search, 404) is retried once on v2 with startAt paging', async () => {
    const paths: string[] = [];
    const t: JiraTransport = async (url) => {
      paths.push(`${url.pathname}?startAt=${url.searchParams.get('startAt') ?? ''}`);
      if (url.pathname.includes('/3/')) return json({}, 404);
      const startAt = Number(url.searchParams.get('startAt'));
      return json({
        startAt,
        total: 3,
        issues: startAt === 0 ? [issue(1, { description: 'h1. Title' }), issue(2)] : [issue(3)],
        names: NAMES,
        schema: SCHEMA,
      });
    };
    const r = await listJiraSprint(args(t));
    expect(paths).toEqual(['/rest/api/3/search/jql?startAt=', '/rest/api/2/search?startAt=0', '/rest/api/2/search?startAt=2']);
    expect(r.tickets.map((x) => x.key)).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
    // v2 wiki markup becomes markdown.
    expect(r.tickets[0]!.description).toContain('# Title');
  });

  it('a refused token is thrown, not swallowed into a fallback', async () => {
    const t: JiraTransport = async () => json({}, 401);
    await expect(listJiraSprint(args(t))).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
