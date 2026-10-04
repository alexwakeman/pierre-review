// The ticket review's currency fold (fingerprint.ts) — pure, no DB.
//   pnpm --filter @pierre-review/backend test ticket-review/fingerprint
import { describe, expect, it, vi } from 'vitest';
import {
  deriveTicketReviewState,
  fingerprint,
  manualTicketIdent,
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

  it('manual idents are scoped to the PR and the story text', () => {
    const id = manualTicketIdent(7, story);
    expect(id).toMatch(/^manual:7:[0-9a-f]{8}$/);
    expect(manualTicketIdent(8, story)).not.toBe(id);
    expect(manualTicketIdent(7, { ...story, title: 'Other' })).not.toBe(id);
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

  it('with no live answer the latest run is current; a run never prepared is stale', () => {
    expect(deriveTicketReviewState({ ident: 'x', latest, runningRunId: null, live: null }).status).toBe('current');
    expect(
      deriveTicketReviewState({ ident: 'x', latest: { ...latest, fingerprint: null }, runningRunId: null, live: null })
        .status,
    ).toBe('stale');
  });
});
