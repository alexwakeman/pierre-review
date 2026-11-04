// STRICTEST STANDING VERDICT on the Open PRs cell, the Pending card and the AI Review tab pill
// (docs/CLAUDE-REVIEW.md § Teammates' reviews → Standing verdicts). Pure.
import { describe, expect, it } from 'vitest';
import type { ClaudeReviewPrState, ClaudeReviewStandingRef, ClaudeReviewStandings } from '@pierre-review/shared';
import {
  latestReviewerLine,
  leadCurrency,
  leadFinishedAt,
  leadVerdictText,
  ownSummaryFor,
  reviewCellFor,
  reviewTabPill,
  standingBlockShown,
} from '../src/lib/claudeReviewColumn.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ROBIN = { userId: 2, login: 'robin-dunn', displayName: 'Robin Dunn', avatarUrl: null };
const youBlock: ClaudeReviewStandingRef = { you: true, poster: null, reviewId: 10, verdict: 'REQUEST_CHANGES', at: '2026-11-03T10:00:00.000Z', headSha: A };
const robinLatest: ClaudeReviewStandingRef = { you: false, poster: ROBIN, reviewId: 20, verdict: 'COMMENT', at: '2026-11-04T10:00:00.000Z', headSha: B };
const standing = (over: Partial<ClaudeReviewStandings> = {}): ClaudeReviewStandings => ({ reviewers: [], blocking: youBlock, latest: robinLatest, ...over });
const summary = { findings: { blocker: 2, warning: 0, nit: 0, question: 0, praise: 0 }, lenses: {}, postedFindings: 2, reviewPosted: true, tickets: [], followUp: null };

// 203001: the reader's pair asked for changes (3 Nov); Robin's Limn commented later (4 Nov) and leads.
const st = (over: Partial<ClaudeReviewPrState> = {}): ClaudeReviewPrState => ({
  prId: 1,
  reviewId: 10,
  status: 'succeeded',
  verdict: 'REQUEST_CHANGES',
  reviewedHeadSha: A,
  finishedAt: '2026-11-03T10:00:00.000Z',
  ticket: null,
  headMoved: true,
  currentHeadSha: B,
  summary,
  teammateLead: { reviewId: 20, login: 'robin-dunn', name: 'Robin Dunn', avatarUrl: null, verdict: 'COMMENT', postedAt: robinLatest.at, reviewedHeadSha: B, headMoved: false },
  standing: standing(),
  ...over,
});

describe('the strictest verdict in force', () => {
  it("203001: the reader's Request changes still shows, naming Robin as the latest reviewer", () => {
    const cell = reviewCellFor(st(), false);
    expect(cell).toMatchObject({ kind: 'done', verdict: 'REQUEST_CHANGES', stillBlocking: true, headMoved: true });
    if (cell.kind !== 'done') throw new Error('done');
    expect(cell.by).toBeUndefined();
    expect(leadVerdictText(cell)).toBe('Request changes');
    expect(cell.latest?.text).toBe('Latest: Robin · Comment · 4 Nov');
    expect(leadFinishedAt(st())).toBe(youBlock.at);
    expect(leadCurrency(st())).toMatchObject({ tone: 'behind' });
    // The block is the reader's latest run (same head): its figures show.
    expect(ownSummaryFor(cell, st())).toEqual(summary);
  });

  it("a teammate's block over the reader's newer Approve: theirs shows, attributed", () => {
    const robinBlock = { ...robinLatest, verdict: 'REQUEST_CHANGES' as const };
    const s = st({ verdict: 'APPROVE', teammateLead: undefined, standing: standing({ blocking: robinBlock, latest: { ...youBlock, reviewId: 11, verdict: 'APPROVE', at: '2026-11-05T10:00:00.000Z' } }) });
    const cell = reviewCellFor(s, false);
    if (cell.kind !== 'done') throw new Error('done');
    expect(leadVerdictText(cell)).toBe('Robin · Request changes');
    expect(cell.latest?.text).toBe('Latest: You · Approve · 5 Nov');
    expect(ownSummaryFor(cell, s)).toBeUndefined();
  });

  it('nothing to raise when the cell already leads with the block', () => {
    expect(standingBlockShown(st({ teammateLead: undefined }))).toBeNull();
    const robinBlock = { ...robinLatest, verdict: 'REQUEST_CHANGES' as const };
    expect(standingBlockShown(st({ teammateLead: { ...st().teammateLead!, verdict: 'REQUEST_CHANGES' }, standing: standing({ blocking: robinBlock }) }))).toBeNull();
    expect(standingBlockShown(st({ standing: standing({ blocking: null }) }))).toBeNull();
  });

  it("a run of the reader's in flight still shows as running", () => {
    expect(reviewCellFor(st({ status: 'running', teammateLead: undefined }), false)).toEqual({ kind: 'running' });
    expect(reviewCellFor(st(), true)).toEqual({ kind: 'starting' });
  });

  it('the AI Review tab pill says Request changes while one stands', () => {
    expect(
      reviewTabPill(
        { review: { status: 'succeeded', verdict: 'APPROVE' }, teamView: { lead: 'teammate', teammateReviewId: 20, standings: { blocking: youBlock } }, teammateReviews: [{ reviewId: 20, verdict: 'COMMENT' }] },
        false,
      ),
    ).toEqual({ kind: 'verdict', verdict: 'REQUEST_CHANGES', label: 'Request changes' });
  });

  it('latestReviewerLine names the reader as You', () => {
    expect(latestReviewerLine(youBlock).text).toBe('Latest: You · Request changes · 3 Nov');
  });
});
