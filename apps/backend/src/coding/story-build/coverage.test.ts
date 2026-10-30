// THE GAP FOLD (coverage.ts). Pinned:
//   1. no ticket PR ⇒ every criterion a gap ('none'), AC refs from the story's own numbering;
//   2. a CURRENT check ⇒ its verdicts: met is done (with the PRs that deliver it), everything else and every
//      missing item a gap; no check is started;
//   3. stale / none ⇒ ONE manual check is started and WAITED on, then folded; a failed or timed-out check
//      ⇒ every criterion a gap with the one line; a check that cannot start ⇒ the last verdicts, 'stale';
//   4. a cancel while waiting throws (the manager settles the session).
import { describe, expect, it } from 'vitest';
import type { TicketAssessment } from '@pierre-review/shared';
import { COVERAGE_CHECK_FAILED, COVERAGE_CHECK_STALE, assessCoverage, foldCoverage, gapRefsOf, type CoverageSeams, type CoverageState } from './coverage.js';
import type { StoryBuildTicketPr } from './inputs.js';

const CRITERIA = [
  { n: 1, text: 'Refund by card' },
  { n: 2, text: 'Email a receipt' },
];
const PR: StoryBuildTicketPr = { prId: 5, repoId: 1, number: 12, title: 'ACME-1 refunds', headSha: 'abc', state: 'open', headRefName: 'f', byReader: true };
const ASSESSMENT: TicketAssessment = {
  alignment: 'partly_aligned',
  summary: 's',
  criteria: [
    { ref: 'AC1', index: 0, text: 'AC1: Refund by card', status: 'met', explanation: null, deliveredBy: [5, 5], evidence: [], expectedIn: null },
    { ref: 'AC2', index: 1, text: 'Email a receipt', status: 'partly_met', explanation: null, deliveredBy: [5], evidence: [], expectedIn: null },
  ],
  missing: [{ ref: 'M1', title: 'An audit log line', explanation: null, expectedIn: null }],
  notRequested: [],
};
const LATEST = { id: 9, assessment: ASSESSMENT, completedAt: new Date('2026-10-01T00:00:00Z'), fingerprint: 'f', ticketHash: 'h', alignment: null, members: [] };

describe('foldCoverage', () => {
  it('no ticket PR: every criterion is a gap', () => {
    const c = foldCoverage({ criteria: CRITERIA, check: null, state: 'none', prs: [], note: null });
    expect(c.criteria).toEqual([
      { ref: 'AC1', text: 'Refund by card', verdict: 'not_checked', coveredByPrIds: [] },
      { ref: 'AC2', text: 'Email a receipt', verdict: 'not_checked', coveredByPrIds: [] },
    ]);
    expect(gapRefsOf(c)).toEqual(['AC1', 'AC2']);
  });

  it("a check's verdicts: met is done, the rest and every missing item are gaps", () => {
    const c = foldCoverage({ criteria: CRITERIA, check: LATEST, state: 'checked', prs: [PR], note: null });
    expect(c).toMatchObject({ state: 'checked', ticketReviewId: 9, checkedAt: '2026-10-01T00:00:00.000Z' });
    expect(c.criteria[0]).toEqual({ ref: 'AC1', text: 'Refund by card', verdict: 'met', coveredByPrIds: [5] });
    expect(c.criteria[1]!.coveredByPrIds).toEqual([]);
    expect(c.existingPrs).toEqual([{ prId: 5, repoId: 1, number: 12, state: 'open', headSha: 'abc' }]);
    expect(gapRefsOf(c)).toEqual(['AC2', 'M1']);
  });
});

function fakeSeams(o: { current: boolean; statuses?: Array<string | null>; start?: 'queued' | 'busy'; after?: CoverageState['latest'] }) {
  const calls = { started: 0 };
  let polls = 0;
  const seams: CoverageSeams = {
    checkState: async () => ({ latest: calls.started > 0 && o.after !== undefined ? o.after : LATEST, runningRunId: null }),
    liveTicketHash: async () => 'h',
    isCurrent: async () => o.current,
    startCheck: async () => {
      calls.started += 1;
      return o.start === 'busy' ? { outcome: 'busy' } : { outcome: 'queued', runId: 77 };
    },
    runStatus: async () => (o.statuses?.[polls++] ?? 'succeeded') as never,
    sleep: async () => {},
  };
  return { seams, calls };
}

const args = (signal = new AbortController().signal) => ({
  accountId: 1,
  workspaceId: 1,
  ident: 'jira:https://acme.atlassian.net#ACME-1',
  ticketKey: 'ACME-1',
  ticketTitle: 'Refunds',
  criteria: CRITERIA,
  prs: [PR],
  signal,
});

describe('assessCoverage', () => {
  const ctx = {} as never;

  it('no PRs: no check, every criterion a gap', async () => {
    const { seams, calls } = fakeSeams({ current: false });
    const c = await assessCoverage(ctx, { ...args(), prs: [] }, seams);
    expect(c.state).toBe('none');
    expect(calls.started).toBe(0);
  });

  it('a current check is folded as it is', async () => {
    const { seams, calls } = fakeSeams({ current: true });
    expect((await assessCoverage(ctx, args(), seams)).state).toBe('checked');
    expect(calls.started).toBe(0);
  });

  it('stale: starts ONE manual check, waits, folds the new one', async () => {
    const fresh = { ...LATEST, id: 10 };
    const { seams, calls } = fakeSeams({ current: false, statuses: ['queued', 'running', 'succeeded'], after: fresh });
    const c = await assessCoverage(ctx, args(), seams);
    expect(calls.started).toBe(1);
    expect(c).toMatchObject({ state: 'checked', ticketReviewId: 10, note: null });
  });

  it('a failed check: every criterion a gap, said once', async () => {
    const { seams } = fakeSeams({ current: false, statuses: ['failed'] });
    const c = await assessCoverage(ctx, args(), seams);
    expect(c).toMatchObject({ state: 'failed', note: COVERAGE_CHECK_FAILED, ticketReviewId: null });
    expect(gapRefsOf(c)).toEqual(['AC1', 'AC2']);
  });

  it('a timeout reads as a failed check', async () => {
    const { seams } = fakeSeams({ current: false, statuses: Array(10).fill('running') });
    expect((await assessCoverage(ctx, { ...args(), timeoutMs: -1 }, seams)).state).toBe('failed');
  });

  it('a check that cannot start: the last verdicts, stale', async () => {
    const { seams } = fakeSeams({ current: false, start: 'busy' });
    expect(await assessCoverage(ctx, args(), seams)).toMatchObject({ state: 'stale', ticketReviewId: 9, note: COVERAGE_CHECK_STALE });
  });

  it('a cancel while waiting throws', async () => {
    const ac = new AbortController();
    const { seams } = fakeSeams({ current: false, statuses: ['running', 'running'] });
    seams.sleep = async () => ac.abort();
    await expect(assessCoverage(ctx, args(ac.signal), seams)).rejects.toThrow('cancelled');
  });
});
