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
    const out = r.rebase({ a: '2026-01-09T08:30:00.000Z', nested: [{ at: '2026-01-10T12:00:00Z' }] });
    expect(out).toEqual({ a: '2026-01-19T08:30:00.000Z', nested: [{ at: '2026-01-20T12:00:00.000Z' }] });
  });

  it('shifts epoch milliseconds only under *At / *Ms keys and only near capturedAt', () => {
    const out = r.rebase({ createdAt: CAPTURED_MS, resumeAtMs: CAPTURED_MS - DAY, waitMs: 5_400_000, count: CAPTURED_MS });
    expect(out.createdAt).toBe(CAPTURED_MS + 10 * DAY);
    expect(out.resumeAtMs).toBe(CAPTURED_MS + 9 * DAY);
    expect(out.waitMs).toBe(5_400_000); // a duration, not a moment
    expect(out.count).toBe(CAPTURED_MS); // not an *At / *Ms key
  });

  it('moves calendar values by whole days: midnights, dates and sprint keys together', () => {
    const late = makeRebaser(CAPTURED, CAPTURED_MS + 10 * DAY + 5 * 3_600_000); // 10 days 5 hours
    const out = late.rebase({
      start: '2026-01-05T00:00:00.000Z',
      at: '2026-01-09T08:30:00.000Z',
      day: '2026-01-09',
      key: 'sprint-2026-01-05',
      title: 'Fix 2026-01-09T08:30:00Z parsing',
    });
    expect(out.start).toBe('2026-01-15T00:00:00.000Z'); // still a midnight
    expect(out.at).toBe('2026-01-19T13:30:00.000Z'); // the exact delta
    expect(out.day).toBe('2026-01-19');
    expect(out.key).toBe('sprint-2026-01-15'); // the same days as `start`
    expect(out.title).toBe('Fix 2026-01-09T08:30:00Z parsing'); // prose is left alone
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
    const res = await srv.handle('GET', '/api/pro/insights/reports/sprint-2026-02-04?workspace=1', null, null);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { report: { periodKey: string } }).report.periodKey).toBe('sprint-2026-02-04');
  });

  it('serves rebased bodies from the server, and the same answer twice', async () => {
    const srv = new DemoServer(recording([{ method: 'GET', path: '/api/x', status: 200, body: { at: '2026-01-10T00:00:00.000Z' } }]), {
      now: () => CAPTURED_MS + DAY,
    });
    const one = (await (await srv.handle('GET', '/api/x', null, null)).json()) as { at: string };
    const two = (await (await srv.handle('GET', '/api/x', null, null)).json()) as { at: string };
    expect(one.at).toBe('2026-01-11T00:00:00.000Z');
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
    const hit = index.match('GET', '/api/open-prs?workspace=9&from=2026-01-01T00:00:00Z');
    expect(hit?.how).toBe('path');
    expect(hit?.entry.body).toEqual({ which: 'ws1' });
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

  it('mergeSettings writes each key where it already lives', () => {
    expect(mergeSettings({ a: 1, inner: { b: 2 } }, { b: 3, c: 4 })).toEqual({ a: 1, inner: { b: 3 }, c: 4 });
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
});
