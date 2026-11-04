// THE AI REVIEW TAB'S TEAM LAYOUT (lib/teamReview.ts): where the PR stands, findings by their state
// across every review (each naming who raised it), every review on the PR, and NEWEST ALWAYS SHOWS.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend teamReview
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  ClaudeReviewStanding,
  ClaudeReviewSummary,
  ClaudeTeamAuthor,
  ClaudeTeammatePoster,
  ClaudeTeammateReview,
  ClaudeTeamPoint,
} from '@pierre-review/shared';
import {
  closedReason,
  itemShows,
  newestReviewKey,
  nextShownReview,
  pairReviewIdsOf,
  raisedByLabel,
  reviewListLine,
  reviewsOnPr,
  standingLine,
  standingRows,
  teamFindingRows,
} from '../src/lib/teamReview.js';

const robin: ClaudeTeammatePoster = { userId: 9, login: 'robin-dunn', displayName: 'Robin Dunn', avatarUrl: null };
const you: ClaudeTeamAuthor = { you: true, poster: null };
const byRobin: ClaudeTeamAuthor = { you: false, poster: robin };

const SHA_A = '8a8ec14'.padEnd(40, '0');
const SHA_B = '1c4bd65'.padEnd(40, '0');

describe('where this PR stands', () => {
  const youBlocking: ClaudeReviewStanding = {
    you: true,
    poster: null,
    latest: { you: true, poster: null, reviewId: 10, verdict: 'REQUEST_CHANGES', at: '2026-11-03T10:00:00Z', headSha: SHA_A },
    inForce: { you: true, poster: null, reviewId: 10, verdict: 'REQUEST_CHANGES', at: '2026-11-03T10:00:00Z', headSha: SHA_A },
    dismissed: false,
  };
  const robinComment: ClaudeReviewStanding = {
    you: false,
    poster: robin,
    latest: { you: false, poster: robin, reviewId: 20, verdict: 'COMMENT', at: '2026-11-04T09:00:00Z', headSha: SHA_B },
    inForce: null,
    dismissed: false,
  };

  it('one line per reviewer, newest first, the block flagged', () => {
    const rows = standingRows({ reviewers: [youBlocking, robinComment], blocking: youBlocking.inForce, latest: robinComment.latest });
    expect(rows.map(standingLine)).toEqual([
      'Robin · Comment · 4 Nov · 1c4bd65',
      'You · Request changes · 3 Nov · 8a8ec14 · still blocking on GitHub',
    ]);
    expect(rows.map((r) => r.blocking)).toEqual([false, true]);
  });

  it('an older block under a newer Comment of the same person names its day', () => {
    const later: ClaudeReviewStanding = {
      ...youBlocking,
      latest: { you: true, poster: null, reviewId: 11, verdict: 'COMMENT', at: '2026-11-05T10:00:00Z', headSha: SHA_B },
    };
    expect(standingLine(standingRows({ reviewers: [later], blocking: later.inForce, latest: later.latest })[0]!)).toBe(
      'You · Comment · 5 Nov · 1c4bd65 · Request changes from 3 Nov still blocking on GitHub',
    );
  });

  it('a dismissed review says so; an approval in force says it stands', () => {
    const dismissed: ClaudeReviewStanding = { ...youBlocking, inForce: null, dismissed: true };
    expect(standingRows({ reviewers: [dismissed], blocking: null, latest: dismissed.latest })[0]!.note).toBe('dismissed on GitHub');
    const approved: ClaudeReviewStanding = {
      ...robinComment,
      latest: { ...robinComment.latest!, verdict: 'APPROVE' },
      inForce: { ...robinComment.latest!, verdict: 'APPROVE' },
    };
    const row = standingRows({ reviewers: [approved], blocking: null, latest: approved.latest })[0]!;
    expect(row.note).toBe('approval stands on GitHub');
    expect(row.blocking).toBe(false);
  });

  it('nothing to show without standings', () => {
    expect(standingRows(undefined)).toEqual([]);
    expect(standingRows({ reviewers: [], blocking: null, latest: null })).toEqual([]);
  });
});

const point = (id: number, over: Partial<ClaudeTeamPoint> = {}): ClaudeTeamPoint => ({
  findingId: id,
  reviewId: 10,
  origin: 'own',
  author: you,
  providers: ['claude'],
  path: 'src/a.ts',
  line: id,
  severity: 'warning',
  title: `Point ${id}`,
  body: `Point ${id}`,
  raisedAt: '2026-11-03T10:00:00Z',
  headSha: SHA_A,
  githubUrl: null,
  threadId: null,
  posted: true,
  ignored: false,
  state: { kind: 'open' },
  alsoRaisedBy: [],
  ...over,
});

describe('who raised it', () => {
  const pairIds = new Set([10, 11]);

  it("names the model only for a pair's finding", () => {
    expect(raisedByLabel(point(1, { providers: ['codex'] }), pairIds).label).toBe('You · Codex');
    expect(raisedByLabel(point(2, { providers: ['claude'] }), pairIds).label).toBe('You · Claude');
    expect(raisedByLabel(point(3, { providers: ['claude', 'codex'] }), pairIds).label).toBe('You · Claude + Codex');
    // Not a pair: the name alone.
    expect(raisedByLabel(point(4, { reviewId: 12 }), pairIds).label).toBe('You');
  });

  it("a teammate's finding names them; one both raised names both, the reader first", () => {
    const mate = point(5, { origin: 'teammate', author: byRobin, reviewId: 20, providers: [] });
    expect(raisedByLabel(mate, pairIds)).toEqual({ label: 'Robin', posters: [robin] });
    const both = point(6, {
      origin: 'teammate',
      author: byRobin,
      reviewId: 20,
      alsoRaisedBy: [{ ...you, findingId: 60, reviewId: 10, providers: ['codex'] }],
    });
    expect(raisedByLabel(both, pairIds)).toEqual({ label: 'You and Robin', posters: [robin] });
  });
});

describe('findings by their state now', () => {
  it('the 203001 shape: every thread resolved on GitHub ⇒ Open empty, Resolved holds all five', () => {
    const points = [
      ...[1, 2, 3, 4].map((id) => point(id, { state: { kind: 'resolved_on_github' } })),
      point(5, { origin: 'teammate', author: byRobin, reviewId: 20, state: { kind: 'resolved_on_github' } }),
    ];
    const { open, closed } = teamFindingRows(points, []);
    expect(open).toEqual([]);
    expect(closed).toHaveLength(5);
    expect(closed.map((p) => closedReason(p.state))).toEqual(Array(5).fill('Resolved on GitHub'));
  });

  it('says whose review found it addressed, and when', () => {
    expect(
      closedReason({ kind: 'addressed', by: byRobin, at: '2026-11-04T09:00:00Z', reviewId: 20 }),
    ).toBe('Robin’s review found it addressed · 4 Nov');
    expect(
      closedReason({ kind: 'no_longer_applies', by: you, at: '2026-11-04T09:00:00Z', reviewId: 11 }),
    ).toBe('Your review found it no longer applies · 4 Nov');
    expect(closedReason({ kind: 'open' })).toBeNull();
  });

  it("the latest run's own findings ride on their point; a stray one still lists; severity leads", () => {
    const own = [
      { id: 1, severity: 'nit' as const },
      { id: 7, severity: 'blocker' as const },
    ];
    const points = [
      point(1, { severity: 'nit' }),
      point(5, { origin: 'teammate', author: byRobin, reviewId: 20, severity: 'warning' }),
    ];
    const { open } = teamFindingRows(points, own);
    expect(open.map((e) => (e.kind === 'own' ? `own:${e.finding.id}` : `point:${e.point.findingId}:${e.own?.id ?? '-'}`))).toEqual([
      'own:7',
      'point:5:-',
      'point:1:1',
    ]);
  });

  it('an ignored point is left out unless it is a latest-run finding; Story check findings are left out', () => {
    const points = [point(1, { ignored: true }), point(2, { ignored: true }), point(3)];
    const { open } = teamFindingRows(points, [{ id: 2, severity: 'warning' as const }], new Set([3]));
    expect(open.map((e) => (e.kind === 'point' ? e.point.findingId : e.finding.id))).toEqual([2]);
  });
});

const run = (id: number, over: Partial<ClaudeReviewSummary> = {}): ClaudeReviewSummary => ({
  id,
  headSha: SHA_A,
  status: 'succeeded',
  model: 'claude-opus-5-5',
  provider: 'claude',
  scope: 'diff_only',
  reviewMode: 'diff_only',
  verdict: 'COMMENT',
  userVerdict: null,
  costUsd: null,
  postedAt: null,
  createdAt: '2026-11-03T10:00:00Z',
  finishedAt: '2026-11-03T10:05:00Z',
  trigger: 'manual',
  ...over,
});

const mateReview = (over: Partial<ClaudeTeammateReview> = {}): ClaudeTeammateReview => ({
  reviewId: 20,
  poster: robin,
  headSha: SHA_B,
  headInferred: false,
  postedAt: '2026-11-04T09:00:00Z',
  githubUrl: null,
  summary: 'Looks fine.',
  verdict: 'COMMENT',
  run: 'manual',
  pair: false,
  runs: [{ provider: 'claude', model: null, effort: null }],
  limnVersion: null,
  findings: [],
  ...over,
});

describe('reviews on this PR', () => {
  const history = [
    run(11, { pair: { pairId: 5, role: 'second' } as never, provider: 'codex', verdict: 'REQUEST_CHANGES' }),
    run(10, { pair: { pairId: 5, role: 'first' } as never, verdict: 'REQUEST_CHANGES' }),
    run(9, { status: 'failed', verdict: null, createdAt: '2026-11-02T10:00:00Z', finishedAt: '2026-11-02T10:01:00Z', trigger: 'auto' }),
  ];
  const items = reviewsOnPr(history, [mateReview()]);

  it("lists the reader's runs (a pair once) and teammates' reviews, newest first", () => {
    expect(items.map((i) => i.who)).toEqual(['Robin', 'You', 'You']);
    expect(items.map(reviewListLine)).toEqual([
      'Comment · 4 Nov · 1c4bd65 · Claude',
      'Request changes · 3 Nov · 8a8ec14 · Claude + Codex',
      'Failed · 2 Nov · 8a8ec14 · Claude · Auto review',
    ]);
    expect(items[1]!.runIds).toEqual([11, 10]);
  });

  it("either half of a pair shows the pair's row", () => {
    expect(itemShows(items[1]!, { kind: 'own', id: 10 })).toBe(true);
    expect(itemShows(items[1]!, { kind: 'own', id: 11 })).toBe(true);
    expect(itemShows(items[0]!, { kind: 'teammate', reviewId: 20 })).toBe(true);
    expect(itemShows(items[0]!, { kind: 'own', id: 20 })).toBe(false);
  });

  it('every pair half, the reader’s and teammates’, is a pair review', () => {
    expect([...pairReviewIdsOf(history, [mateReview({ reviewId: 21, pair: true })])].sort()).toEqual([10, 11, 21]);
  });
});

describe('newest always shows', () => {
  const picked = { kind: 'own' as const, id: 3 };

  it('a picked past review stays while nothing new arrives', () => {
    const key = newestReviewKey(5, [mateReview()]);
    expect(nextShownReview({ shown: picked, newestKey: key, previousKey: key })).toEqual(picked);
  });

  it("the reader's next run takes over the moment it is queued (auto or manual)", () => {
    expect(
      nextShownReview({ shown: picked, newestKey: newestReviewKey(6, []), previousKey: newestReviewKey(5, []) }),
    ).toBeNull();
  });

  it("a teammate's newly imported review takes over", () => {
    const before = newestReviewKey(5, [mateReview()]);
    const after = newestReviewKey(5, [mateReview(), mateReview({ reviewId: 22, postedAt: '2026-11-05T09:00:00Z' })]);
    expect(after).not.toBe(before);
    expect(nextShownReview({ shown: { kind: 'teammate', reviewId: 20 }, newestKey: after, previousKey: before })).toBeNull();
  });

  it('the first read never moves a pick; now stays now', () => {
    expect(nextShownReview({ shown: picked, newestKey: newestReviewKey(5, []), previousKey: null })).toEqual(picked);
    expect(nextShownReview({ shown: null, newestKey: 'a', previousKey: 'b' })).toBeNull();
  });
});

// The tab's small items: the ⓘ beside "Run a review", Add tickets collapsed, the Story check's key
// plain text.
describe('the tab, by its source', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('"Review only, or review and post" is the Run a review section’s own ⓘ', () => {
    const tab = read('../src/components/ClaudeReviewTab.tsx');
    expect(tab).toMatch(/title="Run a review"\s*info=\{\s*<InfoButton title="Review only, or review and post">/);
  });

  it('Add tickets starts collapsed, behind a chevron', () => {
    const box = read('../src/components/TicketPasteBox.tsx');
    expect(box).toContain('useState(false)');
    expect(box).toContain("<ChevronIcon dir={open ? 'down' : 'right'}");
    expect(box).not.toContain('startOpen');
  });

  it('the Story check names the ticket without linking into the tracker', () => {
    const coverage = read('../src/components/TicketCoverage.tsx');
    expect(coverage).not.toContain('JiraKeyLink');
    expect(coverage.match(/<StoryDisclosure[^>]*linkKey=\{false\}/g)?.length).toBe(2);
  });
});
