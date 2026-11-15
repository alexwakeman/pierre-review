// JIRA — many tickets' statuses in one search (tracker/jira/statuses.ts; docs/TRACKERS.md § Batched
// status reads): chunks of 100 keys, the v3 → v2 fallback, the split on a 400 (one missing key), and
// the mapping of each answer.
import { describe, expect, it } from 'vitest';
import type { TrackerCall } from '../types.js';
import type { JiraTransport } from './fetch.js';
import { JIRA_STATUS_BATCH, jiraStatusAnswers, jiraStatusJql, readJiraStatuses } from './statuses.js';

const issue = (key: string, status = 'Done', category = 'done') => ({
  key,
  fields: { summary: `${key} title`, status: { id: '3', name: status, statusCategory: { key: category } }, issuetype: { name: 'Story' } },
});

function callWith(handler: (url: URL) => { status: number; body: unknown }): { call: TrackerCall; urls: URL[] } {
  const urls: URL[] = [];
  const transport: JiraTransport = async (url) => {
    urls.push(url);
    const r = handler(url);
    return { status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) };
  };
  return {
    urls,
    call: { provider: 'jira', apiRoot: 'https://acme.atlassian.net', credentials: { email: 'a@acme.test', token: 't' }, policy: { cloud: false }, transport },
  };
}

const keysOf = (url: URL): string[] => (/key in \(([^)]*)\)/.exec(url.searchParams.get('jql') ?? '')?.[1] ?? '').split(', ').filter(Boolean);

describe('readJiraStatuses', () => {
  it('600 keys → 6 searches of ≤ 100, status + summary + issuetype only, each answer mapped', async () => {
    const keys = Array.from({ length: 600 }, (_, i) => `BMD-${i + 1}`);
    const { call, urls } = callWith((url) => ({ status: 200, body: { issues: keysOf(url).map((k) => issue(k, k === 'BMD-7' ? 'In Progress' : 'Done', k === 'BMD-7' ? 'indeterminate' : 'done')) } }));
    const r = await readJiraStatuses(call, keys);
    expect(r.calls).toBe(6);
    expect(urls.every((u) => u.pathname === '/rest/api/3/search/jql')).toBe(true);
    expect(urls.every((u) => u.searchParams.get('fields') === 'status,summary,issuetype')).toBe(true);
    expect(urls.map((u) => keysOf(u).length)).toEqual([100, 100, 100, 100, 100, 100]);
    expect(r.answers.get('BMD-7')).toEqual({ state: 'ok', key: 'BMD-7', title: 'BMD-7 title', status: { name: 'In Progress', category: 'indeterminate' } });
    expect(r.answers.get('BMD-600')).toMatchObject({ state: 'ok', status: { name: 'Done', category: 'done' } });
    expect(JIRA_STATUS_BATCH).toBe(100);
  });

  it('a Server / Data Center site (no v3 search) is asked on v2 for the rest of the batch', async () => {
    const { call, urls } = callWith((url) =>
      url.pathname === '/rest/api/3/search/jql' ? { status: 404, body: {} } : { status: 200, body: { issues: keysOf(url).map((k) => issue(k)) } },
    );
    const r = await readJiraStatuses(call, Array.from({ length: 150 }, (_, i) => `OPS-${i + 1}`));
    expect(urls.map((u) => u.pathname)).toEqual(['/rest/api/3/search/jql', '/rest/api/2/search', '/rest/api/2/search']);
    expect(r.answers.size).toBe(150);
  });

  it('one key that does not exist (Jira refuses the whole JQL with 400): split down to it, the rest answered', async () => {
    const { call } = callWith((url) => (keysOf(url).includes('BMD-13') ? { status: 400, body: { errorMessages: ['nope'] } } : { status: 200, body: { issues: keysOf(url).map((k) => issue(k)) } }));
    const r = await readJiraStatuses(call, Array.from({ length: 100 }, (_, i) => `BMD-${i + 1}`));
    expect(r.answers.get('BMD-13')).toEqual({ state: 'not_found', key: 'BMD-13' });
    expect([...r.answers.values()].filter((a) => a.state === 'ok')).toHaveLength(99);
    expect(r.calls).toBeLessThanOrEqual(1 + 2 * 7);
  });

  it('a key absent from a good answer is `missing` (moved: read on its own); 401 → no access; 5xx → failed; a malformed key → not found', async () => {
    const answers = jiraStatusAnswers({ issues: [issue('NEW-9'), issue('AB-1')] }, ['AB-1', 'OLD-9']);
    expect(answers.get('OLD-9')).toEqual({ state: 'missing', key: 'OLD-9' });
    const denied = await readJiraStatuses(callWith(() => ({ status: 401, body: {} })).call, ['AB-1']);
    expect(denied.answers.get('AB-1')).toEqual({ state: 'no_access', key: 'AB-1' });
    const down = await readJiraStatuses(callWith(() => ({ status: 503, body: {} })).call, ['AB-1', 'bad key']);
    expect(down.answers.get('AB-1')).toEqual({ state: 'failed', key: 'AB-1' });
    expect(down.answers.get('bad key')).toEqual({ state: 'not_found', key: 'bad key' });
    expect(jiraStatusJql(['AB-1', 'BC-2'])).toBe('key in (AB-1, BC-2)');
  });
});
