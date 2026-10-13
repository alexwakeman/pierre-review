// The referenced-ticket status lookup (./ref-status.ts): which keys a sprint names (pure), and the
// Jira batched search — `key in (…)`, summary + status only, chunked, a 400 chunk BISECTED down to
// the one key Jira does not know, the call budget, and the Server / DC v2 retry. No request leaves the
// process: every answer comes from the fake transport.
import { describe, expect, it } from 'vitest';
import { JiraFetchError, type JiraTransport, type RawResponse } from '../jira/fetch.js';
import type { TrackerCall } from '../types.js';
import { SPRINT_REF_CALLS_MAX, SPRINT_REF_CHUNK, jiraRefLister, refJql, refTicketsOf, sprintReferencedKeys } from './ref-status.js';

const ROOT = 'https://acme.atlassian.net';
const SITE = { provider: 'jira' as const, root: ROOT };
const json = (body: unknown, status = 200): RawResponse => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const call = (transport: JiraTransport): TrackerCall => ({
  provider: 'jira',
  apiRoot: ROOT,
  credentials: { email: 'me@acme.com', token: 'tok' },
  policy: { cloud: false },
  transport,
});
const hit = (key: string, status = 'Done', cat = 'done') => ({ key, fields: { summary: `Title ${key}`, status: { name: status, statusCategory: { key: cat } } } });
const keysOf = (url: URL): string[] => [...(url.searchParams.get('jql') ?? '').matchAll(/"([A-Z0-9]+-\d+)"/g)].map((m) => m[1]!);

describe('sprintReferencedKeys', () => {
  it('links on the site always, bare keys only in a known project, every tracker link, never the sprint’s own', () => {
    const rows = [
      {
        issueKey: 'BMD-1056',
        description: 'Supersedes https://acme.atlassian.net/browse/BMD-850 and see https://other.atlassian.net/browse/BMD-9. UTF-8 BMD-1056 OPS-4',
        acceptanceCriteria: 'Directed to BMD-343. Also BMD-1001.',
        blockedByJson: [
          { key: 'XYZ-7', title: null, status: null, category: null, relation: 'is blocked by', url: null },
          { key: 'XYZ-8', title: 'Known', status: 'To Do', category: 'new', relation: 'is blocked by', url: null },
        ],
      },
      { issueKey: 'BMD-1001', description: 'Uses BMD-343', acceptanceCriteria: null },
    ];
    expect(sprintReferencedKeys(rows, SITE, ['BMD'])).toEqual(['XYZ-7', 'XYZ-8', 'BMD-850', 'BMD-343']);
  });
});

describe('jiraRefLister', () => {
  it('one call for a small set: key in (…), every field (the text too), browse links on the site', async () => {
    const seen: URL[] = [];
    const t: JiraTransport = async (url) => {
      seen.push(url);
      return json({ issues: keysOf(url).map((k) => hit(k)), isLast: true });
    };
    const r = await jiraRefLister(call(t), ['BMD-850', 'BMD-343', 'not a key'], ROOT);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pathname).toBe('/rest/api/3/search/jql');
    expect(seen[0]!.searchParams.get('jql')).toBe(refJql(['BMD-850', 'BMD-343']));
    expect(seen[0]!.searchParams.get('fields')).toBe('*all');
    expect(seen[0]!.searchParams.get('expand')).toBe('names,schema');
    expect(r).toEqual({
      complete: true,
      tickets: [
        { key: 'BMD-850', title: 'Title BMD-850', status: 'Done', category: 'done', url: `${ROOT}/browse/BMD-850` },
        { key: 'BMD-343', title: 'Title BMD-343', status: 'Done', category: 'done', url: `${ROOT}/browse/BMD-343` },
      ],
    });
  });

  it('chunks a large set and BISECTS a 400 down to the one key Jira does not know', async () => {
    const keys = Array.from({ length: SPRINT_REF_CHUNK + 6 }, (_, i) => `BMD-${i + 1}`);
    let calls = 0;
    const t: JiraTransport = async (url) => {
      calls += 1;
      const asked = keysOf(url);
      if (asked.includes('BMD-3')) return json({ errorMessages: ['An issue with key BMD-3 does not exist'] }, 400);
      return json({ issues: asked.map((k) => hit(k, 'To Do', 'new')) });
    };
    const r = await jiraRefLister(call(t), keys, ROOT);
    expect(r.complete).toBe(true);
    expect(r.tickets.map((x) => x.key).sort()).toEqual(keys.filter((k) => k !== 'BMD-3').sort());
    // 50 → 25 → 13 → 7 → 4 → 2 → 1, each with its sibling, + the second chunk: bounded, not per key.
    expect(calls).toBeLessThanOrEqual(SPRINT_REF_CALLS_MAX);
  });

  it('stops at the call budget and says it is incomplete', async () => {
    const keys = Array.from({ length: SPRINT_REF_CHUNK * 3 }, (_, i) => `BMD-${i + 1}`);
    let calls = 0;
    const t: JiraTransport = async () => {
      calls += 1;
      return json({}, 400);
    };
    const r = await jiraRefLister(call(t), keys, ROOT);
    expect(r).toEqual({ tickets: [], complete: false });
    expect(calls).toBe(SPRINT_REF_CALLS_MAX);
  });

  it('a Server / DC site (no v3 search) is asked on v2; any other failure throws', async () => {
    const paths: string[] = [];
    const t: JiraTransport = async (url) => {
      paths.push(url.pathname);
      return url.pathname.includes('/3/') ? json({}, 404) : json({ issues: [hit('BMD-1')] });
    };
    expect((await jiraRefLister(call(t), ['BMD-1'], ROOT)).tickets.map((x) => x.key)).toEqual(['BMD-1']);
    expect(paths).toEqual(['/rest/api/3/search/jql', '/rest/api/2/search']);
    await expect(jiraRefLister(call(async () => json({}, 401)), ['BMD-1'], ROOT)).rejects.toBeInstanceOf(JiraFetchError);
  });

  it('refTicketsOf reads a ghost’s TEXT from a full answer: description, the criteria field, type, assignee, links', () => {
    const raw = {
      names: { customfield_1: 'Acceptance Criteria' },
      schema: {},
      issues: [
        {
          key: 'BMD-7',
          fields: {
            summary: 'Ghost',
            description: 'The page shows the list.',
            customfield_1: '- The list is sorted',
            issuetype: { id: '10001', name: 'Story' },
            assignee: { displayName: 'Ann', avatarUrls: {} },
            status: { name: 'To Do', statusCategory: { key: 'new' } },
            issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'BMD-8', fields: { summary: 'API', status: { name: 'Done', statusCategory: { key: 'done' } } } } }],
          },
        },
      ],
    };
    const [g] = refTicketsOf(raw, ROOT, ROOT);
    expect(g).toMatchObject({
      key: 'BMD-7',
      title: 'Ghost',
      status: 'To Do',
      description: 'The page shows the list.',
      acceptanceCriteria: '- The list is sorted',
      issueTypeName: 'Story',
    });
    expect(g!.assignee?.name).toBe('Ann');
    expect(g!.blockedBy?.map((l) => [l.key, l.relation])).toEqual([['BMD-8', 'is blocked by']]);
  });

  it('refTicketsOf ignores junk and a non-https browse base', () => {
    expect(refTicketsOf({ issues: [{ key: 'nope', fields: {} }, hit('BMD-2')] }, 'http://jira.local')).toEqual([
      { key: 'BMD-2', title: 'Title BMD-2', status: 'Done', category: 'done', url: null },
    ]);
    expect(refTicketsOf(null, ROOT)).toEqual([]);
  });
});
