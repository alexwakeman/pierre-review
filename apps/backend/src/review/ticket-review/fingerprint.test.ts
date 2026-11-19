// The ticket review's currency fold (fingerprint.ts) — pure, no DB.
//   pnpm --filter @pierre-review/backend test ticket-review/fingerprint
import { describe, expect, it, vi } from 'vitest';
import {
  deriveTicketReviewState,
  fingerprint,
  memberStateOf,
  staleReasons,
  ticketHash,
} from './fingerprint.js';

const story = { title: 'Export', description: 'd', acceptanceCriteria: '- CSV\n- PDF' };
const a = { prId: 1, headSha: 'aaa', state: 'open' as const };
const b = { prId: 2, headSha: 'bbb', state: 'open' as const };

describe('fingerprint', () => {
  it('does not depend on the clock', () => {
    const h = ticketHash(story);
    const first = fingerprint(h, [a, b]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    try {
      expect(fingerprint(h, [a, b])).toBe(first);
      expect(ticketHash(story)).toBe(h);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores member order and moves on head, state, membership and story', () => {
    const h = ticketHash(story);
    const fp = fingerprint(h, [a, b]);
    expect(fingerprint(h, [b, a])).toBe(fp);
    expect(fingerprint(h, [a, { ...b, headSha: 'ccc' }])).not.toBe(fp);
    expect(fingerprint(h, [a, { ...b, state: 'merged' }])).not.toBe(fp);
    expect(fingerprint(h, [a])).not.toBe(fp);
    expect(fingerprint(ticketHash({ ...story, acceptanceCriteria: '- CSV' }), [a, b])).not.toBe(fp);
  });

  it('a closed-but-unmerged PR is never a member', () => {
    expect(memberStateOf('open')).toBe('open');
    expect(memberStateOf('merged')).toBe('merged');
    expect(memberStateOf('closed')).toBeNull();
  });
});

describe('staleReasons', () => {
  it('names every move in order', () => {
    const r = staleReasons(
      { ticketHash: 'h1', members: [a, b, { prId: 3, headSha: 'x', state: 'open' }] },
      {
        ticketHash: 'h2',
        members: [{ ...a, headSha: 'a2' }, { ...b, state: 'merged' }, { prId: 4, headSha: 'y', state: 'open' }],
      },
    );
    expect(r.reasons).toEqual(['story_edited', 'pr_added', 'pr_left', 'pr_pushed', 'pr_merged']);
    expect(r.changedPrIds).toEqual([1, 2, 3, 4]);
  });
});

describe('deriveTicketReviewState', () => {
  const h = ticketHash(story);
  const latest = {
    id: 10,
    fingerprint: fingerprint(h, [a, b]),
    ticketHash: h,
    alignment: 'partly_aligned' as const,
    assessment: null,
    completedAt: new Date('2026-10-01T00:00:00Z'),
    members: [a, b],
  };

  it('none / current / stale / running', () => {
    expect(deriveTicketReviewState({ ident: 'x', latest: null, runningRunId: null, live: null }).status).toBe('none');
    expect(
      deriveTicketReviewState({ ident: 'x', latest, runningRunId: null, live: { ticketHash: h, members: [b, a] } })
        .status,
    ).toBe('current');
    const stale = deriveTicketReviewState({
      ident: 'x',
      latest,
      runningRunId: null,
      live: { ticketHash: h, members: [a, { ...b, headSha: 'b2' }] },
    });
    expect(stale.status).toBe('stale');
    expect(stale.staleBecause).toEqual(['pr_pushed']);
    expect(stale.changedPrIds).toEqual([2]);
    expect(
      deriveTicketReviewState({ ident: 'x', latest, runningRunId: 11, live: { ticketHash: h, members: [a] } }).status,
    ).toBe('running');
  });

  it("a person's new comment: stale ('new_comments') only when the caller says a criterion is not done", () => {
    const live = { ticketHash: h, members: [a, b] };
    const st = deriveTicketReviewState({ ident: 'x', latest, runningRunId: null, live, newCommentsStale: true });
    expect(st.status).toBe('stale');
    expect(st.staleBecause).toEqual(['new_comments']);
    expect(deriveTicketReviewState({ ident: 'x', latest, runningRunId: null, live, newCommentsStale: false }).status).toBe('current');
    // Joined to a code move, both are named.
    const both = deriveTicketReviewState({
      ident: 'x',
      latest,
      runningRunId: null,
      live: { ticketHash: h, members: [a, { ...b, headSha: 'b2' }] },
      newCommentsStale: true,
    });
    expect(both.staleBecause).toEqual(['pr_pushed', 'new_comments']);
    // No run yet: nothing to be stale.
    expect(deriveTicketReviewState({ ident: 'x', latest: null, runningRunId: null, live, newCommentsStale: true }).status).toBe('none');
  });

  it('with no live answer the latest run is current; a run never prepared is stale', () => {
    expect(deriveTicketReviewState({ ident: 'x', latest, runningRunId: null, live: null }).status).toBe('current');
    expect(
      deriveTicketReviewState({ ident: 'x', latest: { ...latest, fingerprint: null }, runningRunId: null, live: null })
        .status,
    ).toBe('stale');
  });
});

// ⚠ CODE OUTSIDE THE TICKET IS CONTEXT, NOT AN INPUT (outside.ts): a run that read another repository's
// default branch stays CURRENT when that branch moves; a member's push still makes it stale.
describe('fingerprint — code outside the ticket', () => {
  const h = ticketHash(story);
  const latest = (outsideSha: string) => ({
    id: 9,
    fingerprint: fingerprint(h, [a, b]),
    ticketHash: h,
    alignment: 'aligned' as const,
    assessment: {
      alignment: 'aligned' as const,
      summary: null,
      criteria: [],
      missing: [],
      notRequested: [],
      outside: {
        sources: [{ ref: 'X1', kind: 'repo' as const, repoId: 7, repo: 'acme/docs', prId: null, number: null, sha: outsideSha, read: true }],
        leftOut: [],
      },
    },
    completedAt: new Date(0),
    members: [a, b],
  });

  it('an outside SHA moving changes nothing; a member head moving makes the run stale', () => {
    const live = { ticketHash: h, members: [a, b] };
    expect(deriveTicketReviewState({ ident: 'i', latest: latest('d1'), runningRunId: null, live }).status).toBe('current');
    expect(deriveTicketReviewState({ ident: 'i', latest: latest('d2'), runningRunId: null, live }).status).toBe('current');
    const pushed = { ticketHash: h, members: [a, { ...b, headSha: 'ccc' }] };
    const s = deriveTicketReviewState({ ident: 'i', latest: latest('d1'), runningRunId: null, live: pushed });
    expect([s.status, s.staleBecause]).toEqual(['stale', ['pr_pushed']]);
  });
});
