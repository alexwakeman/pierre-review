// CODE OUTSIDE THE TICKET — the pure halves and the checkout seams (no DB, no git). What this pins:
//   1. `branchNameMatchable`: a branch named like either repository's default branch ties nothing.
//   2. `prepareOutside`: ⚠ a per-source TIME LIMIT names a stalled repository "not read" and the run goes on
//      (a checkout finishing later is removed at once); the run's ABORT stops the waiting; a failure is
//      REMEMBERED (no retry inside the backoff, a retry after it).
//   3. `namePrRefs`: only the X refs this run handed out, only standing alone.
//   4. An `expectedIn` naming a related repository with an UNLINKED same-branch PR names that PR, never
//      "No PR yet".
//   5. ⚠ The switch is in the fingerprint (OFF adds a part, ON adds nothing); outside SHAs are not.
//
//   pnpm --filter @pierre-review/backend test ticket-review/outside.test
import { afterEach, describe, expect, it } from 'vitest';
import { noPrWords } from '@pierre-review/shared';
import { _resetOutsideBackoffForTest, branchNameMatchable, prepareOutside, type OutsidePlan } from './outside.js';
import { namePrRefs, reconcileTicketReview, type ReconcileMember } from './reconcile.js';
import { withNoPrIn } from './persist.js';
import { deriveTicketReviewState, fingerprint, ticketHash } from './fingerprint.js';

afterEach(() => _resetOutsideBackoffForTest());

const plan = (names: string[]): OutsidePlan => ({
  repos: names.map((n, i) => ({ repoId: i + 1, owner: 'acme', name: n, defaultBranch: 'main' })),
  unlinked: [],
  leftOut: [],
});

/** A fake clone cache: `slow` never answers until released; `fail` errors; the rest check out at once. */
function fakeDefaults(o: { slow?: string[]; fail?: string[] } = {}) {
  const calls: string[] = [];
  const removed: string[] = [];
  const release: Array<() => void> = [];
  const prep = async (repos: Array<{ owner: string; name: string; branch: string | null }>) => {
    const r = repos[0]!;
    calls.push(r.name);
    if (o.fail?.includes(r.name)) throw new Error('clone failed');
    if (o.slow?.includes(r.name)) await new Promise<void>((res) => release.push(res));
    return {
      checkouts: [{ ...r, path: `/wt/${r.name}`, repoCloneDir: '/c', sha: `sha-${r.name}`, error: null }],
      cleanup: async () => void removed.push(r.name),
    };
  };
  return { prep: prep as never, calls, removed, release };
}

describe('branchNameMatchable', () => {
  it('a default-branch name ties nothing; any other name does', () => {
    expect(branchNameMatchable('pay-1', ['main', 'develop'])).toBe(true);
    expect(branchNameMatchable('main', ['main', null])).toBe(false);
    expect(branchNameMatchable('develop', [null, 'develop'])).toBe(false);
    expect(branchNameMatchable('', ['main'])).toBe(false);
    expect(branchNameMatchable(' pay-1 ', [])).toBe(true);
  });
});

describe('prepareOutside — time limit, abort, backoff', () => {
  it('⚠ a stalled repository is "not read" after the time limit, the rest are read, and a late checkout is removed', async () => {
    const f = fakeDefaults({ slow: ['slow'] });
    const out = await prepareOutside(plan(['api', 'slow', 'web']), { prepDefaults: f.prep, timeoutMs: 30 });
    expect(out.context.sources.map((x) => [x.repo, x.read])).toEqual([
      ['acme/api', true],
      ['acme/slow', false],
      ['acme/web', true],
    ]);
    expect(out.roots).toEqual(['/wt/api', '/wt/web']);
    // The stalled checkout finishes after the run gave up: removed at once, never a root.
    f.release.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 10));
    expect(f.removed).toContain('slow');
    await out.cleanup();
    expect(f.removed.sort()).toEqual(['api', 'slow', 'web']);
  });

  it('the run\'s abort stops the waiting, and nothing new starts', async () => {
    const f = fakeDefaults({ slow: ['a', 'b', 'c', 'd', 'e'] });
    const abort = new AbortController();
    const p = prepareOutside(plan(['a', 'b', 'c', 'd', 'e']), { prepDefaults: f.prep, timeoutMs: 60_000 }, abort.signal);
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    const out = await p;
    expect(out.context.sources.every((x) => !x.read)).toBe(true);
    // 4 at a time: the fifth never started.
    expect(f.calls).toEqual(['a', 'b', 'c', 'd']);
    // An abort is not a failure: no backoff remembered.
    const again = fakeDefaults();
    await prepareOutside(plan(['a']), { prepDefaults: again.prep });
    expect(again.calls).toEqual(['a']);
  });

  it('remembers a failure: no retry inside the backoff, a retry after it', async () => {
    let now = 1_000;
    const failing = fakeDefaults({ fail: ['bad'] });
    const first = await prepareOutside(plan(['bad', 'ok']), { prepDefaults: failing.prep, backoffMs: 500, now: () => now });
    expect(first.context.sources.map((x) => x.read)).toEqual([false, true]);
    const ok = fakeDefaults();
    now = 1_400;
    const second = await prepareOutside(plan(['bad', 'ok']), { prepDefaults: ok.prep, backoffMs: 500, now: () => now });
    expect(ok.calls).toEqual(['ok']);
    expect(second.context.sources.find((x) => x.repo === 'acme/bad')?.read).toBe(false);
    now = 1_600;
    const third = await prepareOutside(plan(['bad']), { prepDefaults: ok.prep, backoffMs: 500, now: () => now });
    expect(third.context.sources[0]?.read).toBe(true);
    // A timeout is remembered too.
    const slow = fakeDefaults({ slow: ['slow'] });
    await prepareOutside(plan(['slow']), { prepDefaults: slow.prep, timeoutMs: 10, now: () => now });
    const later = fakeDefaults();
    await prepareOutside(plan(['slow']), { prepDefaults: later.prep, now: () => now });
    expect(later.calls).toEqual([]);
  });
});

const members: ReconcileMember[] = [{ ref: 'PR1', prId: 11, repoId: 1, repo: 'acme/api', number: 5, checkedOut: true }];
const outside = {
  sources: [
    { ref: 'X1', kind: 'repo' as const, repoId: 7, repo: 'acme/docs', prId: null, number: null, sha: 'd', read: true },
    { ref: 'X2', kind: 'repo' as const, repoId: 8, repo: 'acme/web', prId: null, number: null, sha: 'w', read: true },
    { ref: 'X3', kind: 'unlinked_pr' as const, repoId: 8, repo: 'acme/web', prId: 88, number: 88, sha: 'u', read: true },
  ],
  leftOut: [],
};

describe('namePrRefs — X refs', () => {
  it('rewrites only refs this run handed out, standing alone', () => {
    expect(namePrRefs('Done in X1 and (X3).', members, outside.sources)).toBe('Done in acme/docs and (web#88).');
    expect(namePrRefs('X1, X2: both.', members, outside.sources)).toBe('acme/docs, acme/web: both.');
    // Not handed out, lower case, a leading zero, or inside a name: left alone.
    for (const t of ['X9 is unknown', 'x1 lower', 'X01 padded', 'the X11-server', 'acme/X2 path', 'v.X2 tag', 'X2-ray', 'X1/foo', 'X1.ts']) {
      expect(namePrRefs(t, members, outside.sources)).toBe(t);
    }
    expect(namePrRefs('PR1 and X1', members, [])).toBe('api#5 and X1');
  });
});

describe('expectedIn — a related repository with an unlinked same-branch PR', () => {
  it('names that PR, never "No PR yet"', () => {
    const r = reconcileTicketReview(
      { acceptanceCriteria: '- CSV' },
      members,
      {
        alignment: 'partly_aligned',
        criteria: [{ text: 'CSV', status: 'not_met', explanation: 'x', expectedIn: { repo: 'acme/web' } }],
        missing: [{ title: 'Docs page', expectedIn: { repo: 'acme/docs' } }],
      },
      new Map(),
      outside,
    );
    expect(r.assessment.criteria[0]!.expectedIn).toEqual({ prId: null, repoId: 8, outsideRepo: 'acme/web', outsideUnlinkedPr: { prId: 88, number: 88 } });
    const item = (ref: string, status: 'not_met' | 'missing') =>
      withNoPrIn({ id: 1, ticketReviewId: 1, ref, status, title: 't', body: '', ownerPrId: null, path: null, line: null, priorItemId: null, posted: null }, r.assessment);
    const ac = item('AC1', 'not_met');
    expect([ac.noPrIn, ac.noPrUnlinked]).toEqual(['acme/web', { prId: 88, number: 88 }]);
    expect(noPrWords(ac.noPrIn!, ac.noPrUnlinked)).toBe('acme/web#88 is on the same branch but not linked to the ticket');
    const m = item('M1', 'missing');
    expect(noPrWords(m.noPrIn!, m.noPrUnlinked)).toBe('No PR yet in acme/docs');
  });
});

describe('fingerprint — the switch is an input, outside SHAs are not', () => {
  const h = ticketHash({ title: 't', description: 'd', acceptanceCriteria: '- a' });
  const ms = [{ prId: 1, headSha: 'a', state: 'open' as const }];
  it('ON adds nothing (older runs keep their fingerprint); OFF adds a part', () => {
    expect(fingerprint(h, ms, { outsideOff: false })).toBe(fingerprint(h, ms));
    expect(fingerprint(h, ms, { outsideOff: true })).not.toBe(fingerprint(h, ms));
  });
  it('switching it makes the latest run stale, with no reason named', () => {
    const latest = (off: boolean) => ({
      id: 1,
      fingerprint: fingerprint(h, ms, { outsideOff: off }),
      ticketHash: h,
      alignment: 'aligned' as const,
      assessment: null,
      completedAt: null,
      members: ms,
    });
    const state = (off: boolean, nowOff: boolean) =>
      deriveTicketReviewState({ ident: 'i', latest: latest(off), runningRunId: null, live: { ticketHash: h, members: ms, outsideOff: nowOff } });
    expect(state(false, false).status).toBe('current');
    expect([state(false, true).status, state(false, true).staleBecause]).toEqual(['stale', []]);
    expect(state(true, false).status).toBe('stale');
    expect(state(true, true).status).toBe('current');
  });
});
