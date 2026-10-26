// The static demo's in-browser API (src/demo/): the time rebase, request matching, the write
// overlay and stream replay. Run by hand like every frontend test:
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend

import { describe, expect, it } from 'vitest';
import { makeRebaser } from '../src/demo/rebase.js';
import { RecordingIndex, normalisePath } from '../src/demo/recording.js';
import type { DemoRecording, RecordedStreamFrame } from '../src/demo/recording.js';
import { DemoServer } from '../src/demo/server.js';
import { sseResponse } from '../src/demo/sse.js';
import { createDemoFetch } from '../src/demo/install.js';
import { mergeSettings } from '../src/demo/routes.js';

const CAPTURED = '2026-01-10T12:00:00.000Z';
const CAPTURED_MS = Date.parse(CAPTURED);
const DAY = 86_400_000;

async function readStream(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((b) => b.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => l != null)
    .map((l) => JSON.parse(l.slice(5)) as unknown);
}

function recording(entries: DemoRecording['entries']): DemoRecording {
  return { version: 1, capturedAt: CAPTURED, entries };
}

describe('time rebase', () => {
  const r = makeRebaser(CAPTURED, CAPTURED_MS + 10 * DAY);

  it('shifts every ISO timestamp by now − capturedAt', () => {
    const out = r.rebase({ a: '2026-01-09T08:30:00.000Z', nested: [{ at: '2026-01-10T12:00:07Z' }] });
    expect(out).toEqual({ a: '2026-01-19T08:30:00.000Z', nested: [{ at: '2026-01-20T12:00:07.000Z' }] });
  });

  it('shifts epoch milliseconds only under *At / *Ms keys and only near capturedAt', () => {
    const event = CAPTURED_MS + 61_000; // an event time, off the hour
    const out = r.rebase({ createdAt: event, resumeAtMs: event - DAY, waitMs: 5_400_000, count: event });
    expect(out.createdAt).toBe(event + 10 * DAY);
    expect(out.resumeAtMs).toBe(event + 9 * DAY);
    expect(out.waitMs).toBe(5_400_000); // a duration, not a moment
    expect(out.count).toBe(event); // not an *At / *Ms key
  });

  it('moves calendar values by whole WEEKS: midnights, local midnights, dates and sprint keys together', () => {
    const late = makeRebaser(CAPTURED, CAPTURED_MS + 10 * DAY + 5 * 3_600_000); // 10 days 5 hours
    expect(late.days).toBe(7); // the nearest whole week
    const out = late.rebase({
      start: '2026-01-05T00:00:00.000Z', // a Monday, UTC midnight
      londonWeek: '2026-05-03T23:00:00.000Z', // a Monday, Europe/London midnight (BST)
      startMs: Date.parse('2026-05-03T23:00:00.000Z'),
      at: '2026-01-09T08:30:00.000Z',
      day: '2026-01-05',
      key: 'sprint-2026-01-05',
      title: 'Fix 2026-01-09T08:30:00Z parsing',
    });
    expect(out.start).toBe('2026-01-12T00:00:00.000Z'); // still a Monday midnight
    expect(new Date(out.start).getUTCDay()).toBe(1);
    expect(out.londonWeek).toBe('2026-05-10T23:00:00.000Z'); // still the same local midnight
    expect(out.startMs).toBe(Date.parse('2026-05-10T23:00:00.000Z'));
    expect(out.at).toBe('2026-01-19T13:30:00.000Z'); // an event: the exact delta
    expect(out.day).toBe('2026-01-12'); // the same days as `start`
    expect(out.key).toBe('sprint-2026-01-12');
    expect(out.title).toBe('Fix 2026-01-09T08:30:00Z parsing'); // prose is left alone
  });

  it("recomputes an in-progress month's elapsed days from its shifted start", () => {
    const r2 = makeRebaser('2026-10-22T20:51:21.000Z', Date.parse('2026-11-03T10:00:00.000Z'));
    const out = r2.rebase({
      periodKey: 'month-2026-10',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      cadenceDays: 31,
      inProgress: true,
      elapsedDays: 21,
    });
    expect(out).toMatchObject({ periodKey: 'month-2026-11', periodStart: '2026-11-01T00:00:00.000Z', cadenceDays: 30, elapsedDays: 2 });
    // A finished month keeps its recorded count.
    expect(r2.rebase({ periodKey: 'month-2026-09', periodStart: '2026-09-01T00:00:00.000Z', inProgress: false, elapsedDays: 30 }).elapsedDays).toBe(30);
  });

  it("moves month keys by calendar months and rewrites that period's dates", () => {
    const later = makeRebaser(CAPTURED, Date.parse('2026-03-02T09:00:00.000Z')); // January → March
    expect(later.months).toBe(2);
    const out = later.rebase({
      periods: [
        { periodKey: 'month-2025-12', periodStart: '2025-12-01T00:00:00.000Z', periodEnd: '2026-01-01T00:00:00.000Z', cadenceDays: 31 },
        { periodKey: 'month-2026-01', periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z', cadenceDays: 31, inProgress: true },
      ],
      priorPeriodKey: 'month-2025-12',
    });
    expect(out.periods[0]).toEqual({ periodKey: 'month-2026-02', periodStart: '2026-02-01T00:00:00.000Z', periodEnd: '2026-03-01T00:00:00.000Z', cadenceDays: 28 });
    expect(out.periods[1]).toMatchObject({ periodKey: 'month-2026-03', periodStart: '2026-03-01T00:00:00.000Z', cadenceDays: 31, inProgress: true });
    expect(out.priorPeriodKey).toBe('month-2026-02');
  });

  it("moves period keys in a request path back to the recording's calendar", () => {
    const later = makeRebaser(CAPTURED, Date.parse('2026-03-02T09:00:00.000Z'));
    const shifted = later.rebase({ s: 'sprint-2026-01-05', m: 'month-2025-12' });
    expect(later.unshiftPath(`/api/pro/insights/reports/${shifted.s}?workspace=1`)).toBe('/api/pro/insights/reports/sprint-2026-01-05?workspace=1');
    expect(later.unshiftPath(`/api/pro/insights/reports/${shifted.m}/generate`)).toBe('/api/pro/insights/reports/month-2025-12/generate');
    expect(later.unshiftPath('/api/prs/113?x=sprint-2026-03-01')).toBe('/api/prs/113?x=sprint-2026-03-01'); // the query is not a path
  });

  it('answers a shifted period key from the entry recorded under the original one', async () => {
    const srv = new DemoServer(
      recording([{ method: 'GET', path: '/api/pro/insights/reports/sprint-2026-01-05?workspace=1', status: 200, body: { report: { periodKey: 'sprint-2026-01-05' } } }]),
      { now: () => CAPTURED_MS + 30 * DAY },
    );
    // 30 days on is four whole weeks for calendar values.
    const res = await srv.handle('GET', '/api/pro/insights/reports/sprint-2026-02-02?workspace=1', null, null);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { report: { periodKey: string } }).report.periodKey).toBe('sprint-2026-02-02');
  });

  it('serves rebased bodies from the server, and the same answer twice', async () => {
    const srv = new DemoServer(recording([{ method: 'GET', path: '/api/x', status: 200, body: { at: '2026-01-10T08:15:30.000Z' } }]), {
      now: () => CAPTURED_MS + DAY,
    });
    const one = (await (await srv.handle('GET', '/api/x', null, null)).json()) as { at: string };
    const two = (await (await srv.handle('GET', '/api/x', null, null)).json()) as { at: string };
    expect(one.at).toBe('2026-01-11T08:15:30.000Z');
    expect(two).toEqual(one);
  });
});

describe('matching', () => {
  it('normalises the query: sorted, time parameters dropped', () => {
    expect(normalisePath('/api/timeline?workspace=1&from=2026-01-01T00:00:00.000Z&to=2026-01-10T00:00:00.000Z&repoIds=2,1')).toBe(
      '/api/timeline?repoIds=2,1&workspace=1',
    );
    expect(normalisePath('/api/x?b=2&a=1&since=1767225600000')).toBe('/api/x?a=1&b=2');
  });

  const index = new RecordingIndex([
    { method: 'GET', path: '/api/open-prs?workspace=1', status: 200, body: { which: 'ws1' } },
    { method: 'GET', path: '/api/open-prs?workspace=2', status: 200, body: { which: 'ws2' } },
  ]);

  it('prefers the exact method + path + query', () => {
    expect(index.match('GET', '/api/open-prs?workspace=2')?.entry.body).toEqual({ which: 'ws2' });
    expect(index.match('GET', '/api/open-prs?workspace=2')?.how).toBe('exact');
  });

  it('falls back to the path with its query ignored, first recorded wins', () => {
    const hit = index.match('GET', '/api/open-prs?workspace=1&sort=age&from=2026-01-01T00:00:00Z');
    expect(hit?.how).toBe('path');
    expect(hit?.entry.body).toEqual({ which: 'ws1' });
  });

  it("never answers one workspace, bot or person with another's recorded data", () => {
    const idx = new RecordingIndex([
      { method: 'GET', path: '/api/workspaces', status: 200, body: { workspaces: [{ id: 1, isDefault: true }, { id: 2, isDefault: false }] } },
      { method: 'GET', path: '/api/attention?workspace=1', status: 200, body: { which: 'ws1' } },
      { method: 'GET', path: '/api/my-turn', status: 200, body: { which: 'default' } },
      { method: 'GET', path: '/api/bot-analytics/flagging?authorUserIds=8&disagree=over&limit=20&workspace=1', status: 200, body: { which: 'bot8-over' } },
      { method: 'GET', path: '/api/pro/bot-behaviour?botUserId=8&workspace=1', status: 200, body: { which: 'bot8' } },
    ]);
    // Workspace 2 is a recorded workspace with no attention recorded: nothing, never workspace 1.
    expect(idx.match('GET', '/api/attention?workspace=2')).toBeNull();
    // Absent or unknown is the DEFAULT workspace, as on the server.
    expect(idx.match('GET', '/api/attention')?.entry.body).toEqual({ which: 'ws1' });
    expect(idx.match('GET', '/api/attention?workspace=77')?.entry.body).toEqual({ which: 'ws1' });
    expect(idx.match('GET', '/api/my-turn?workspace=1')?.entry.body).toEqual({ which: 'default' });
    expect(idx.match('GET', '/api/my-turn?workspace=2')).toBeNull();
    // Another bot, the other disagreement direction, or no bot at all: nothing.
    expect(idx.match('GET', '/api/bot-analytics/flagging?authorUserIds=9&disagree=over&limit=20&workspace=1')).toBeNull();
    expect(idx.match('GET', '/api/bot-analytics/flagging?authorUserIds=8&disagree=under&limit=20&workspace=1')).toBeNull();
    expect(idx.match('GET', '/api/bot-analytics/flagging?authorUserIds=8&disagree=over&limit=50&workspace=1')?.entry.body).toEqual({ which: 'bot8-over' });
    expect(idx.match('GET', '/api/pro/bot-behaviour?botUserId=20&workspace=1')).toBeNull();
  });

  it('a cursor-paged list ends where the recording ends', async () => {
    const page = (n: number, next: string | null) => ({ items: [n], nextCursor: next, total: 99 });
    const srv = new DemoServer(
      recording([
        { method: 'GET', path: '/api/bot-analytics/flagging?authorUserIds=8&limit=20&workspace=1', status: 200, body: page(1, 'o:20') },
        { method: 'GET', path: '/api/bot-analytics/flagging?authorUserIds=8&cursor=o%3A20&limit=20&workspace=1', status: 200, body: page(2, 'o:40') },
        { method: 'GET', path: '/api/bot-analytics/flagging?authorUserIds=9&limit=20&workspace=1', status: 200, body: page(9, 'o:20') },
      ]),
    );
    const get = async (url: string) => (await (await srv.handle('GET', url, null, null)).json()) as { items: number[]; nextCursor: string | null };
    // Page one names page two, which was recorded: kept.
    expect((await get('/api/bot-analytics/flagging?workspace=1&authorUserIds=8&limit=20')).nextCursor).toBe('o:20');
    // Page two names page three, which was not: the list ends here.
    expect(await get('/api/bot-analytics/flagging?workspace=1&authorUserIds=8&limit=20&cursor=o:20')).toMatchObject({ items: [2], nextCursor: null });
    // An unrecorded cursor is never page one again.
    expect(await get('/api/bot-analytics/flagging?workspace=1&authorUserIds=8&limit=20&cursor=o:40')).toMatchObject({ items: [], nextCursor: null });
    // Bot 9's page two was never recorded under its own query.
    expect((await get('/api/bot-analytics/flagging?workspace=1&authorUserIds=9&limit=20')).nextCursor).toBeNull();
  });

  it('matches timestamp windows the SPA computes at a different moment', () => {
    const idx = new RecordingIndex([
      { method: 'GET', path: '/api/timeline?from=2025-12-01T00:00:00.000Z&to=2026-01-10T12:00:00.000Z&workspace=1', status: 200, body: 1 },
    ]);
    expect(idx.match('GET', '/api/timeline?workspace=1&from=2026-02-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z')?.how).toBe('exact');
  });

  it('does not match another method', () => {
    expect(index.match('POST', '/api/open-prs?workspace=1')).toBeNull();
  });

  it('answers an unrecorded GET with the error shape, never a blank body', async () => {
    const srv = new DemoServer(recording([]));
    const res = await srv.handle('GET', '/api/prs/999', null, null);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'NotInDemo', message: 'Not available in the demo.' });
  });

  it('serves a paged list without asking for a page it does not have', async () => {
    const srv = new DemoServer(
      recording([{ method: 'GET', path: '/api/activity/feed?limit=2&offset=0&workspace=1', status: 200, body: { items: [1, 2], total: 40 } }]),
    );
    const first = (await (await srv.handle('GET', '/api/activity/feed?workspace=1&limit=2&offset=0', null, null)).json()) as { total: number };
    expect(first.total).toBe(2);
    const second = (await (await srv.handle('GET', '/api/activity/feed?workspace=1&limit=2&offset=2', null, null)).json()) as { items: unknown[] };
    expect(second.items).toEqual([]);
  });

  it('the fetch wrapper answers /api/* locally and passes everything else through', async () => {
    const srv = new DemoServer(recording([{ method: 'GET', path: '/api/repos', status: 200, body: [] }]));
    const passed: string[] = [];
    const real = (async (input: RequestInfo | URL) => {
      passed.push(String(input));
      return new Response('ok');
    }) as typeof fetch;
    const f = createDemoFetch(srv, real, 'https://example.test');
    expect(await (await f('/api/repos')).json()).toEqual([]);
    expect(await (await f('/demo/assets/app.js')).text()).toBe('ok');
    expect(await (await f('https://other.test/api/repos')).text()).toBe('ok');
    expect(passed).toEqual(['/demo/assets/app.js', 'https://other.test/api/repos']);
  });
});

describe('the write overlay', () => {
  const pr = {
    id: 5,
    number: 5,
    title: 'Add login',
    repoFullName: 'acme/web',
    headSha: 'f'.repeat(40),
    headRefName: 'feature/login',
    state: 'open',
    mergedAt: null,
    updatedAt: '2026-01-10T11:00:00.000Z',
    threads: [{ id: 50, prId: 5, isResolved: false, derivedState: 'untouched', comments: [] }],
    reviews: [],
    comments: [],
  };
  const base = (): DemoServer =>
    new DemoServer(
      recording([
        { method: 'GET', path: '/api/prs/5', status: 200, body: pr },
        { method: 'GET', path: '/api/open-prs?workspace=1', status: 200, body: { prs: [{ id: 5, state: 'open' }, { id: 6, state: 'open' }] } },
        { method: 'GET', path: '/api/workspaces/1/auto-review', status: 200, body: { workspaceId: 1, autoReview: { enabled: false, dailyCap: 5 } } },
        { method: 'GET', path: '/api/workspaces', status: 200, body: { workspaces: [{ id: 1, name: 'Default', repoIds: [1], repoCount: 1, isDefault: true }] } },
      ]),
      { now: () => CAPTURED_MS },
    );
  const json = async (srv: DemoServer, method: string, url: string, body?: unknown): Promise<any> =>
    (await srv.handle(method, url, body === undefined ? null : JSON.stringify(body), null)).json();

  it('a merge marks the PR merged and takes it off the open list', async () => {
    const srv = base();
    expect(await json(srv, 'POST', '/api/prs/5/merge', { method: 'squash' })).toMatchObject({ merged: true, state: 'merged' });
    expect((await json(srv, 'GET', '/api/prs/5')).state).toBe('merged');
    expect((await json(srv, 'GET', '/api/open-prs?workspace=1')).prs.map((p: { id: number }) => p.id)).toEqual([6]);
  });

  it('a resolve shows the thread resolved, and a reply appends to it', async () => {
    const srv = base();
    expect(await json(srv, 'POST', '/api/threads/50/reply', { body: 'Done.' })).toMatchObject({ body: 'Done.' });
    expect(await json(srv, 'POST', '/api/threads/50/resolve', { resolved: true })).toEqual({ threadId: 50, isResolved: true, derivedState: 'resolved' });
    const thread = (await json(srv, 'GET', '/api/prs/5')).threads[0];
    expect(thread.isResolved).toBe(true);
    expect(thread.comments.map((c: { body: string }) => c.body)).toEqual(['Done.']);
  });

  it('a settings write is read back, folded into the nested object that holds the key', async () => {
    const srv = base();
    const put = await json(srv, 'PUT', '/api/workspaces/1/auto-review', { enabled: true });
    expect(put.autoReview).toEqual({ enabled: true, dailyCap: 5 });
    expect((await json(srv, 'GET', '/api/workspaces/1/auto-review')).autoReview.enabled).toBe(true);
  });

  it('a workspace rename is read back from the list', async () => {
    const srv = base();
    await json(srv, 'PATCH', '/api/workspaces/1', { name: 'Platform' });
    expect((await json(srv, 'GET', '/api/workspaces')).workspaces[0].name).toBe('Platform');
  });

  it('arming auto-merge lists the intent; disarming removes it', async () => {
    const srv = base();
    await json(srv, 'POST', '/api/prs/5/auto-merge', { mergeMethod: 'squash' });
    expect((await json(srv, 'GET', '/api/auto-merge')).requests.map((r: { prId: number }) => r.prId)).toEqual([5]);
    await srv.handle('DELETE', '/api/prs/5/auto-merge', null, null);
    expect((await json(srv, 'GET', '/api/auto-merge')).requests).toEqual([]);
  });

  it('a new server (a reload) forgets every write', async () => {
    const srv = base();
    await json(srv, 'POST', '/api/prs/5/merge', { method: 'squash' });
    expect((await json(base(), 'GET', '/api/prs/5')).state).toBe('open');
  });

  it('a write it cannot simulate answers the error shape', async () => {
    const res = await base().handle('POST', '/api/repos', JSON.stringify({ fullName: 'a/b' }), null);
    expect(res.ok).toBe(false);
    expect(await res.json()).toEqual({ error: 'NotInDemo', message: 'Not available in the demo.' });
  });

  it('a second merge of a merged PR is refused like the server refuses it', async () => {
    const srv = base();
    await json(srv, 'POST', '/api/prs/5/merge', { method: 'squash' });
    const again = await srv.handle('POST', '/api/prs/5/merge', JSON.stringify({ method: 'squash' }), null);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'NotMergeable' });
  });

  it('a Jira status picked in the story view is read back by the story view and the sprint graph', async () => {
    const ident = 'jira:https://acme.atlassian.net#PLAT-1';
    const q = `ident=${encodeURIComponent(ident)}&workspace=1`;
    const ticket = { key: 'PLAT-1', title: 'Login', url: null, provider: 'jira', status: { name: 'To Do', category: 'new' } };
    const srv = new DemoServer(
      recording([
        { method: 'GET', path: `/api/ticket-prs?${q}`, status: 200, body: { workspaceId: 1, ident, found: true, ticket } },
        { method: 'GET', path: '/api/sprint-graph?workspace=1', status: 200, body: { nodes: [{ ident, status: ticket.status }, { ident: 'other', status: null }] } },
      ]),
      { now: () => CAPTURED_MS },
    );
    const list = await json(srv, 'GET', `/api/ticket-status/transitions?${q}`);
    const done = list.transitions.find((t: { to: { name: string } }) => t.to.name === 'Done');
    expect(done).toBeDefined();
    expect(await json(srv, 'POST', '/api/ticket-status?workspace=1', { ident, transitionId: done.id })).toMatchObject({
      ident,
      status: { name: 'Done', category: 'done' },
    });
    expect((await json(srv, 'GET', `/api/ticket-prs?${q}`)).ticket.status).toEqual({ name: 'Done', category: 'done' });
    const nodes = (await json(srv, 'GET', '/api/sprint-graph?workspace=1')).nodes;
    expect(nodes.map((n: { status: { name: string } | null }) => n.status?.name ?? null)).toEqual(['Done', null]);
  });

  it('the demo never offers the conflict resolver it cannot run', async () => {
    expect((await json(base(), 'GET', '/api/me')).conflictResolver).toBe(false);
  });

  it('mergeSettings writes each key where it already lives', () => {
    expect(mergeSettings({ a: 1, inner: { b: 2 } }, { b: 3, c: 4 })).toEqual({ a: 1, inner: { b: 3 }, c: 4 });
  });
});

describe('the write overlay on the Pending reads', () => {
  const ref = (prId: number) => ({ prId, repoId: 1, repoFullName: 'acme/web', prNumber: prId, prTitle: `PR ${prId}`, githubUrl: `https://github.com/acme/web/pull/${prId}` });
  const people = { people: 1, automation: 0 };
  const cards = [
    { id: 'myturn:review_request:5', kind: 'my_turn', reason: 'review_request', relevance: 'direct', automation: null, ...ref(5) },
    { id: 'myturn:thread:6', kind: 'my_turn', reason: 'thread', relevance: 'none', automation: null, ...ref(6) },
    { id: 'wp:merge:5', kind: 'merge', automation: null, mergeStateStatus: 'clean', ...ref(5) },
    { id: 'stalled:6', kind: 'stalled_review', automation: { role: 'dependency' }, mergeStateStatus: 'behind', ...ref(6) },
    // A red trunk names the PR that landed its head — merged long ago. It is about the repo.
    { id: 'cifail:trunk:1', kind: 'ci_failing', arm: 'trunk', prId: 5, repoId: 1, headSha: 'a'.repeat(40) },
  ];
  const attention = {
    cards,
    users: [],
    tabs: [
      {
        key: 'my_turn',
        total: 2,
        kindTotals: { my_turn: 2 },
        cardIds: ['myturn:review_request:5', 'myturn:thread:6'],
        authorTotals: { people: 2, automation: 0 },
        kindAuthorTotals: { my_turn: { people: 2, automation: 0 } },
        relevanceTotals: { mine: 1, others: 1 },
        relevanceAuthorTotals: { mine: people, others: people },
      },
      { key: 'land', total: 1, kindTotals: { merge: 1 }, cardIds: ['wp:merge:5'], authorTotals: people, kindAuthorTotals: { merge: people } },
      { key: 'review', total: 3, kindTotals: { stalled_review: 3 }, cardIds: ['stalled:6'], authorTotals: { people: 2, automation: 1 } },
      { key: 'fixing', total: 1, kindTotals: { ci_failing: 1 }, cardIds: ['cifail:trunk:1'], authorTotals: people },
    ],
    scores: { 'myturn:review_request:5': { relevance: 'direct' }, 'myturn:thread:6': { relevance: 'none' }, 'wp:merge:5': {}, 'stalled:6': {} },
    myTurnDismissed: [],
  };
  const counts = { myTurn: 2, myTurnTotal: 2, myTurnPersonal: 1, myTurnPersonalTotal: 1, myTurnDirect: 1, myTurnDirectTotal: 1, myTurnOther: 1, myTurnOtherTotal: 1, ciFailing: 1, stalled: 3, untouchedThreads: 0, needsReviewer: 0, resolveBacklog: 0, botAnomalies: [], trunkRed: [] };
  const srv = (): DemoServer =>
    new DemoServer(
      recording([
        { method: 'GET', path: '/api/workspaces', status: 200, body: { workspaces: [{ id: 1, name: 'Default', repoIds: [1], isDefault: true }] } },
        { method: 'GET', path: '/api/prs/5', status: 200, body: { id: 5, state: 'open', mergeStateStatus: 'clean', threads: [], reviews: [], comments: [] } },
        { method: 'GET', path: '/api/prs/6', status: 200, body: { id: 6, state: 'open', mergeStateStatus: 'behind', threads: [], reviews: [], comments: [] } },
        { method: 'GET', path: '/api/attention?workspace=1', status: 200, body: attention },
        {
          method: 'GET',
          path: '/api/my-turn',
          status: 200,
          body: { awaitingReview: [{ prId: 5, number: 5, title: 'PR 5', repoFullName: 'acme/web', githubUrl: 'u5' }], threadsAwaiting: [{ prId: 6, prNumber: 6, threadId: 60, repoFullName: 'acme/web' }], redTrunks: [], dismissed: [] },
        },
        { method: 'GET', path: '/api/daily-brief?rollup=1&workspace=1', status: 200, body: { workspaceId: 1, counts, generatedAt: CAPTURED } },
        {
          method: 'GET',
          path: '/api/pro/work-plan?workspace=1',
          status: 200,
          body: {
            enabled: true,
            evidence: {
              workspaceId: 1,
              generatedAt: CAPTURED,
              items: [
                { id: 'wp:merge:5', kind: 'merge', subject: 'pr', prId: 5, cardId: 'wp:merge:5', facts: { mergeStateStatus: 'clean' } },
                { id: 'wp:review:6', kind: 'review', subject: 'pr', prId: 6, cardId: 'stalled:6', facts: { mergeStateStatus: 'behind' } },
              ],
              totals: { merge: 1, review: 1 },
              counts: { myTurn: 2, myTurnPersonal: 1, stalled: 3, untouchedThreads: 0, needsReviewer: 0 },
            },
            plan: { headline: 'h', steps: [{ id: 'wp:merge:5', why: 'a' }, { id: 'wp:review:6', why: 'b' }], parked: null },
          },
        },
      ]),
      { now: () => CAPTURED_MS },
    );
  const json = async (s: DemoServer, method: string, url: string, body?: unknown): Promise<any> =>
    (await s.handle(method, url, body === undefined ? null : JSON.stringify(body), null)).json();
  const tab = (a: any, key: string) => a.tabs.find((t: { key: string }) => t.key === key);

  it('a merged PR leaves every Pending list, and every count that held it', async () => {
    const s = srv();
    await json(s, 'POST', '/api/prs/5/merge', { method: 'squash' });

    const a = await json(s, 'GET', '/api/attention?workspace=1');
    expect(a.cards.map((c: { id: string }) => c.id)).toEqual(['myturn:thread:6', 'stalled:6', 'cifail:trunk:1']);
    expect(tab(a, 'my_turn')).toMatchObject({
      total: 1,
      kindTotals: { my_turn: 1 },
      cardIds: ['myturn:thread:6'],
      authorTotals: { people: 1, automation: 0 },
      kindAuthorTotals: { my_turn: { people: 1, automation: 0 } },
      relevanceTotals: { mine: 0, others: 1 },
      relevanceAuthorTotals: { mine: { people: 0, automation: 0 }, others: people },
    });
    expect(tab(a, 'land')).toMatchObject({ total: 0, kindTotals: { merge: 0 }, cardIds: [], authorTotals: { people: 0, automation: 0 } });
    expect(tab(a, 'fixing')).toMatchObject({ total: 1, cardIds: ['cifail:trunk:1'] }); // the trunk is not the PR
    expect(Object.keys(a.scores)).toEqual(['myturn:thread:6', 'stalled:6']);

    expect((await json(s, 'GET', '/api/my-turn')).awaitingReview).toEqual([]);
    const brief = await json(s, 'GET', '/api/daily-brief?workspace=1&rollup=1');
    expect(brief.counts).toMatchObject({ myTurn: 1, myTurnTotal: 1, myTurnPersonal: 0, myTurnDirect: 0, myTurnOther: 1, stalled: 3, ciFailing: 1 });

    const plan = await json(s, 'GET', '/api/pro/work-plan?workspace=1');
    expect(plan.evidence.items.map((i: { id: string }) => i.id)).toEqual(['wp:review:6']);
    expect(plan.evidence.totals).toEqual({ merge: 0, review: 1 });
    expect(plan.evidence.counts).toMatchObject({ myTurn: 1, myTurnPersonal: 0 });
    expect(plan.plan.steps.map((st: { id: string }) => st.id)).toEqual(['wp:review:6']);
  });

  it('a dismissed My Turn entry moves to Dismissed until it is brought back', async () => {
    const s = srv();
    await json(s, 'PUT', '/api/my-turn/dismissals/pr/6');
    const a = await json(s, 'GET', '/api/attention?workspace=1');
    expect(a.cards.map((c: { id: string }) => c.id)).toEqual(['myturn:review_request:5', 'wp:merge:5', 'stalled:6', 'cifail:trunk:1']);
    expect(tab(a, 'my_turn')).toMatchObject({ total: 1, relevanceTotals: { mine: 1, others: 0 } });
    expect(tab(a, 'review').total).toBe(3); // dismissing is about My Turn only
    expect(a.myTurnDismissed).toMatchObject([{ target: { kind: 'pr', id: 6 }, reason: 'thread', prNumber: 6 }]);
    const mt = await json(s, 'GET', '/api/my-turn');
    expect(mt.threadsAwaiting).toEqual([]);
    expect(mt.dismissed).toMatchObject([{ target: { kind: 'pr', id: 6 }, reason: 'thread' }]);
    expect((await json(s, 'GET', '/api/daily-brief?workspace=1&rollup=1')).counts).toMatchObject({ myTurn: 1, myTurnOther: 0, myTurnPersonal: 1 });

    await s.handle('DELETE', '/api/my-turn/dismissals/pr/6', null, null);
    const back = await json(s, 'GET', '/api/attention?workspace=1');
    expect(tab(back, 'my_turn').total).toBe(2);
    expect(back.myTurnDismissed).toEqual([]);
  });

  it("the cards that stay carry the overlay's PR fields", async () => {
    const s = srv();
    await json(s, 'POST', '/api/prs/6/update-branch', {});
    const a = await json(s, 'GET', '/api/attention?workspace=1');
    expect(a.cards.find((c: { id: string }) => c.id === 'stalled:6').mergeStateStatus).toBe('clean');
    expect(a.cards.find((c: { id: string }) => c.id === 'cifail:trunk:1').headSha).toBe('a'.repeat(40));
    const plan = await json(s, 'GET', '/api/pro/work-plan?workspace=1');
    expect(plan.evidence.items[1].facts.mergeStateStatus).toBe('clean');
  });
});

describe('stream replay', () => {
  it('replays recorded frames as `data:` events, in order, then closes', async () => {
    const frames: RecordedStreamFrame[] = [
      { event: 'message', data: { type: 'snapshot', n: 1 }, delayMs: 0 },
      { event: 'message', data: { type: 'done', n: 2 }, delayMs: 5 },
    ];
    expect(await readStream(sseResponse(frames))).toEqual([{ type: 'snapshot', n: 1 }, { type: 'done', n: 2 }]);
  });

  it('stops when the reader aborts', async () => {
    const ac = new AbortController();
    const res = sseResponse([{ event: 'message', data: 1, delayMs: 10_000 }], { signal: ac.signal });
    const reading = res.text();
    ac.abort();
    await expect(reading).rejects.toThrow();
  });

  it('a started Claude review replays a recorded run: queued, streamed, then finished', async () => {
    let now = CAPTURED_MS;
    const finished = { id: 70, prId: 2, headSha: 'a'.repeat(40), status: 'succeeded', verdict: 'COMMENT', summary: 'ok', findings: [], createdAt: CAPTURED, finishedAt: CAPTURED };
    const srv = new DemoServer(
      recording([
        { method: 'GET', path: '/api/prs/2/claude-review', status: 200, body: { enabled: true, auth: 'ok', review: finished, history: [] } },
        { method: 'GET', path: '/api/prs/9', status: 200, body: { id: 9, headSha: 'b'.repeat(40) } },
      ]),
      { now: () => now, schedule: (fn) => void Promise.resolve().then(fn) },
    );
    const start = (await (await srv.handle('POST', '/api/prs/9/claude-review', '{}', null)).json()) as { reviewId: number };
    now += 1000;
    const running = (await (await srv.handle('GET', '/api/prs/9/claude-review', null, null)).json()) as { review: { id: number; status: string; prId: number } };
    expect(running.review).toMatchObject({ id: start.reviewId, status: 'running', prId: 9 });

    const events = (await readStream(await srv.handle('GET', '/api/prs/9/claude-review/stream', null, null))) as Array<{ type: string; reviewId: number }>;
    expect(events[0]?.type).toBe('snapshot');
    expect(events.at(-1)).toMatchObject({ type: 'done', reviewId: start.reviewId, status: 'succeeded' });
    expect(events.filter((e) => e.type === 'progress').length).toBeGreaterThan(0);

    now += 60_000;
    const done = (await (await srv.handle('GET', '/api/prs/9/claude-review', null, null)).json()) as { review: { status: string; headSha: string; summary: string } };
    expect(done.review).toMatchObject({ status: 'succeeded', headSha: 'b'.repeat(40), summary: 'ok' });
  });

  it('a start with no recorded run of that kind says so', async () => {
    const srv = new DemoServer(recording([]));
    const res = await srv.handle('POST', '/api/prs/9/claude-review', '{}', null);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toBe('Not available in the demo.');
  });

  it('a pushed AI Fix reads pushed afterwards', async () => {
    let now = CAPTURED_MS;
    const finished = { id: 80, prId: 2, headSha: 'a'.repeat(40), status: 'succeeded', summary: 'fixed', pushedAt: '2026-01-09T10:00:00.000Z', pushedBranch: 'old-branch', createdAt: CAPTURED, finishedAt: CAPTURED };
    const srv = new DemoServer(
      recording([
        { method: 'GET', path: '/api/pro/prs/2/ai-fix', status: 200, body: { enabled: true, auth: 'ok', viewerCanPush: true, headInfo: null, fix: finished, history: [] } },
        { method: 'GET', path: '/api/prs/9', status: 200, body: { id: 9, headSha: 'b'.repeat(40), headRefName: 'feature/nine' } },
      ]),
      { now: () => now },
    );
    const start = (await (await srv.handle('POST', '/api/pro/prs/9/ai-fix', '{}', null)).json()) as { fixId: number };
    now += 60_000;
    const read = async () => ((await (await srv.handle('GET', '/api/pro/prs/9/ai-fix', null, null)).json()) as { fix: { pushedBranch: string | null; pushedAt: string | null } }).fix;
    expect(await read()).toMatchObject({ pushedBranch: null, pushedAt: null }); // the template's push was another run's
    const push = await srv.handle('POST', `/api/pro/ai-fixes/${start.fixId}/push`, '{}', null);
    expect(await push.json()).toMatchObject({ pushedBranch: 'feature/nine' });
    expect(await read()).toMatchObject({ pushedBranch: 'feature/nine', pushedAt: new Date(now).toISOString() });
  });
});

describe('the AI provider (Settings → AI)', () => {
  const opusRun = { id: 70, prId: 2, headSha: 'a'.repeat(40), status: 'succeeded', verdict: 'COMMENT', summary: 'ok', findings: [], model: 'claude-opus-5-5', provider: 'claude', createdAt: CAPTURED, finishedAt: CAPTURED };
  const astraRun = { ...opusRun, id: 71, prId: 3, model: 'gpt-6.1-sol', provider: 'codex' };
  const make = (now: () => number = () => CAPTURED_MS): DemoServer =>
    new DemoServer(
      recording([
        { method: 'GET', path: '/api/prs/2/claude-review', status: 200, body: { enabled: true, auth: 'ok', review: opusRun, history: [] } },
        { method: 'GET', path: '/api/prs/3/claude-review', status: 200, body: { enabled: true, auth: 'ok', review: astraRun, history: [] } },
        { method: 'GET', path: '/api/prs/3', status: 200, body: { id: 3, headSha: 'c'.repeat(40) } },
      ]),
      { now },
    );
  const json = async (srv: DemoServer, method: string, url: string, body?: unknown): Promise<any> =>
    (await srv.handle(method, url, body === undefined ? null : JSON.stringify(body), null)).json();

  it('starts at Auto, which is Claude, with both providers signed in', async () => {
    const ai = (await json(make(), 'GET', '/api/me')).ai;
    expect(ai).toMatchObject({ provider: 'claude', providerSetting: { value: 'auto', source: 'settings' }, auth: 'ok' });
    expect(ai.providers.codex).toMatchObject({ runtime: 'ready', auth: 'ok', signedIn: true, plan: 'plus', available: true });
  });

  it('a switch to Codex is read back by /api/me, and the spend reading reads Codex windows in percent only', async () => {
    const srv = make();
    expect(await json(srv, 'PUT', '/api/ai/provider', { value: 'codex' })).toEqual({ setting: { value: 'codex', source: 'settings' }, provider: 'codex' });
    expect((await json(srv, 'GET', '/api/me')).ai).toMatchObject({ provider: 'codex', providerSetting: { value: 'codex' } });
    const budget = await json(srv, 'GET', '/api/ai/budget');
    expect(budget.status).toMatchObject({ provider: 'codex', mode: 'subscription', overBudget: false });
    expect(budget.usage).toMatchObject({ provider: 'codex', route: 'login' });
    expect(budget.usage.account).toMatchObject({ reportedSubscription: 'plus', subscription: null, models: [] });
    // Token-weighted: Limn's tokens ÷ the account's × the window's figure (about 3% of the week).
    expect(budget.usage.limn.weekSharePct).toBeGreaterThan(2);
    expect(budget.usage.limn.weekSharePct).toBeLessThan(4);
    expect(budget.status.subscription.usedSharePct).toBe(budget.usage.limn.weekSharePct);
    expect(budget.settings.weeklyUsd).toBeNull();
    expect(await json(srv, 'PUT', '/api/ai/provider', { value: 'nope' })).toMatchObject({ error: 'BadRequest' });
  });

  it('a run started on Codex is labelled Codex at the same depth, whatever its template ran on', async () => {
    let now = CAPTURED_MS;
    const srv = make(() => now);
    await json(srv, 'PUT', '/api/ai/provider', { value: 'codex' });
    await json(srv, 'POST', '/api/prs/9/claude-review', {});
    now += 60_000;
    expect((await json(srv, 'GET', '/api/prs/9/claude-review')).review).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol' });
    // Back on Claude: a run whose template is the Codex one says Claude Opus.
    await json(srv, 'PUT', '/api/ai/provider', { value: 'claude' });
    await json(srv, 'POST', '/api/prs/3/claude-review', {});
    now += 60_000;
    expect((await json(srv, 'GET', '/api/prs/3/claude-review')).review).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
  });

  it('the canned chat answer names the active provider and is labelled by it', async () => {
    const srv = make();
    await json(srv, 'PUT', '/api/ai/provider', { value: 'codex' });
    const chat = await json(srv, 'POST', '/api/claude-reviews/70/chat', { question: 'Why?' });
    expect(chat.messages.at(-1)).toMatchObject({ role: 'assistant', provider: 'codex', model: 'gpt-6.1-terra' });
    expect(chat.messages.at(-1).content).toContain('Codex is not connected');
  });

  it('signing out of Codex leaves Codex chosen but without a credential', async () => {
    const srv = make();
    await json(srv, 'PUT', '/api/ai/provider', { value: 'codex' });
    expect(await json(srv, 'POST', '/api/ai/codex/logout')).toEqual({ ok: true, message: null });
    expect((await json(srv, 'GET', '/api/me')).ai).toMatchObject({ provider: 'codex', auth: 'none', providers: { codex: { signedIn: false } } });
    expect((await json(srv, 'GET', '/api/ai/budget')).status.route).toBe('none');
    expect(await json(srv, 'POST', '/api/ai/codex/login', { method: 'browser' })).toMatchObject({ login: { state: 'done' }, signedIn: true });
    expect((await json(srv, 'GET', '/api/ai/codex/login')).login).toEqual({ state: 'idle' });
  });
});
