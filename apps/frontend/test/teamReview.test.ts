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
  openAiReviewCount,
  pairReviewIdsOf,
  raisedByLabel,
  reviewListLine,
  reviewListCells,
  visibleReviewItems,
  REVIEWS_LIST_MAX,
  reviewsOnPr,
  standingLine,
  standingRows,
  pointCard,
  teamFindingRows,
  teammateFindingCard,
} from '../src/lib/teamReview.js';
import { canPostReminder, effectivePost, postedChipLabel } from '../src/lib/autoPost.js';
import { shortDayTime } from '../src/lib/claudeReviewColumn.js';

// The day and time a row shows (local clock, so the test holds in any time zone).
const dt = (iso: string): string => shortDayTime(iso);

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

  it('one row per reviewer, newest first, the block flagged; day and 24-hour time, no note', () => {
    const rows = standingRows({ reviewers: [youBlocking, robinComment], blocking: youBlocking.inForce, latest: robinComment.latest });
    expect(rows.map(standingLine)).toEqual([
      `Robin · Comment · ${dt('2026-11-04T09:00:00Z')} · 1c4bd65`,
      `You · Request changes · ${dt('2026-11-03T10:00:00Z')} · 8a8ec14`,
    ]);
    expect(rows.map((r) => r.blocking)).toEqual([false, true]);
    expect(rows.every((r) => !('note' in r))).toBe(true);
  });

  it('the day carries the time, 24-hour clock', () => {
    expect(shortDayTime(new Date(2026, 10, 9, 14, 4).toISOString())).toBe('9 Nov 14:04');
    expect(shortDayTime(new Date(2026, 10, 9, 9, 5).toISOString())).toBe('9 Nov 09:05');
    expect(shortDayTime('not a date')).toBe('');
  });

  it('a block still in force under a newer Comment of the same person: the row reads the block', () => {
    const later: ClaudeReviewStanding = {
      ...youBlocking,
      latest: { you: true, poster: null, reviewId: 11, verdict: 'COMMENT', at: '2026-11-05T10:00:00Z', headSha: SHA_B },
    };
    const row = standingRows({ reviewers: [later], blocking: later.inForce, latest: later.latest })[0]!;
    expect(standingLine(row)).toBe(`You · Request changes · ${dt('2026-11-03T10:00:00Z')} · 8a8ec14`);
    expect(row.blocking).toBe(true);
  });

  it('a dismissed review says so; an approval in force reads Approve', () => {
    const dismissed: ClaudeReviewStanding = { ...youBlocking, inForce: null, dismissed: true };
    expect(standingRows({ reviewers: [dismissed], blocking: null, latest: dismissed.latest })[0]!.verdict).toBe('Request changes (dismissed)');
    const approved: ClaudeReviewStanding = {
      ...robinComment,
      latest: { ...robinComment.latest!, verdict: 'APPROVE' },
      inForce: { ...robinComment.latest!, verdict: 'APPROVE' },
    };
    const row = standingRows({ reviewers: [approved], blocking: null, latest: approved.latest })[0]!;
    expect(row.verdict).toBe('Approve');
    expect(row.verdictKind).toBe('APPROVE');
    expect(row.blocking).toBe(false);
  });

  it('PR 221269: a teammate’s replies-pass Approve (no review row of its own) reads Approve, not their older Comment', () => {
    // robin-dunn's Limn posted a Comment at 13:04 (an imported teammate review), then its replies pass
    // APPROVED at 14:04 — a replies pass is never imported, so `latest` is still the Comment and the
    // approval lives only in `inForce` (its commit from the marker).
    const SHA = 'abd62e3'.padEnd(40, '0');
    const robinApproved: ClaudeReviewStanding = {
      you: false,
      poster: robin,
      latest: { you: false, poster: robin, reviewId: 1377, verdict: 'COMMENT', at: '2026-11-09T13:04:51Z', headSha: SHA },
      inForce: { you: false, poster: robin, reviewId: null, verdict: 'APPROVE', at: '2026-11-09T14:04:21Z', headSha: SHA },
      dismissed: false,
      withdrawn: null,
    };
    const row = standingRows({ reviewers: [robinApproved], blocking: null, latest: robinApproved.latest })[0]!;
    expect(standingLine(row)).toBe(`Robin · Approve · ${dt('2026-11-09T14:04:21Z')} · abd62e3`);
    // An older server sent no commit for it: the column stays empty rather than borrowing the Comment's.
    const noSha = { ...robinApproved, inForce: { ...robinApproved.inForce!, headSha: null } };
    expect(standingRows({ reviewers: [noSha], blocking: null, latest: noSha.latest })[0]!.sha).toBeNull();
  });

  it('PR 221270: an approval withdrawn under a newer Comment reads withdrawn', () => {
    const robinWithdrawn: ClaudeReviewStanding = {
      ...robinComment,
      withdrawn: {
        verdict: 'APPROVE',
        postedAt: '2026-11-09T14:05:09Z',
        headSha: '951c4aa'.padEnd(40, '0'),
        at: '2026-11-09T16:41:46Z',
        byLimn: true,
        reason: '3 warnings found at 951c4aa',
      },
    };
    const row = standingRows({ reviewers: [robinWithdrawn], blocking: null, latest: robinWithdrawn.latest })[0]!;
    expect(standingLine(row)).toBe(`Robin · Approve (withdrawn) · ${dt('2026-11-09T14:05:09Z')} · 951c4aa`);
    // A person's dismissal says "dismissed".
    const byPerson = { ...robinWithdrawn, withdrawn: { ...robinWithdrawn.withdrawn!, byLimn: false, reason: null } };
    expect(standingRows({ reviewers: [byPerson], blocking: null, latest: byPerson.latest })[0]!.verdict).toBe('Approve (dismissed)');
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

describe("the AI Review tab's count", () => {
  type Data = Parameters<typeof openAiReviewCount>[0];
  const run = (status: string, findings: Array<{ id: number; severity: string }>) =>
    ({ status, findings, followUp: null }) as unknown as NonNullable<NonNullable<Data>['review']>;
  const view = (allFindings: ClaudeTeamPoint[]) => ({ allFindings }) as unknown as NonNullable<NonNullable<Data>['teamView']>;

  it('counts every open finding: the fold, plus own findings it does not name; praise and closed ones are not counted', () => {
    const data = {
      review: run('succeeded', [
        { id: 1, severity: 'warning' },
        { id: 2, severity: 'praise' },
        { id: 3, severity: 'nit' },
      ]),
      teamView: view([
        point(1),
        point(5, { origin: 'teammate', author: byRobin, reviewId: 20 }),
        point(6, { state: { kind: 'resolved_on_github' } }),
      ]),
    };
    expect(openAiReviewCount(data)).toBe(3);
  });

  it('is 0 with no data; a run still going adds no own findings', () => {
    expect(openAiReviewCount(undefined)).toBe(0);
    expect(openAiReviewCount({ review: run('running', [{ id: 1, severity: 'warning' }]), teamView: undefined })).toBe(0);
    expect(openAiReviewCount({ review: null, teamView: view([point(5, { origin: 'teammate', author: byRobin, reviewId: 20 })]) })).toBe(1);
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
      `Comment · ${dt(items[0]!.at)} · 1c4bd65 · Claude`,
      `Request changes · ${dt(items[1]!.at)} · 8a8ec14 · Claude + Codex`,
      `Failed · ${dt(items[2]!.at)} · 8a8ec14 · Claude`,
    ]);
    expect(items.map((i) => dt(i.at).split(' ').slice(0, 2).join(' '))).toEqual(['4 Nov', '3 Nov', '2 Nov']);
    expect(items[1]!.runIds).toEqual([11, 10]);
  });

  it('decisions: a teammate’s replies-pass Approve is its own row; a withdrawn verdict says so; a replies pass of yours shows its verdict', () => {
    const withDecisions = reviewsOnPr(
      [run(12, { kind: 'replies', verdict: null, createdAt: '2026-11-05T10:00:00Z', finishedAt: '2026-11-05T10:01:00Z' }), ...history],
      [mateReview()],
      [
        {
          key: 'RV_9',
          you: false,
          poster: robin,
          verdict: 'APPROVE',
          run: 'replies',
          at: '2026-11-09T14:05:09Z',
          headSha: '7f8ea893',
          githubUrl: 'https://github.com/acme/x/pull/1#pullrequestreview-9',
          ref: null,
          withdrawn: { at: '2026-11-09T16:41:46Z', byLimn: true, reason: '3 warnings found at 951c4aa' },
        },
        { key: 'RV_8', you: true, poster: null, verdict: 'APPROVE', run: 'replies', at: '2026-11-05T10:01:00Z', headSha: null, githubUrl: null, ref: { kind: 'own', id: 12 }, withdrawn: null },
      ],
    );
    const w = withDecisions.map((i) => dt(i.at));
    expect(withDecisions.map(reviewListLine)).toEqual([
      `Approve (withdrawn) · ${w[0]} · 7f8ea89 · Replies checked`,
      `Approve · ${w[1]} · 8a8ec14 · Replies checked`,
      `Comment · ${w[2]} · 1c4bd65 · Claude`,
      `Request changes · ${w[3]} · 8a8ec14 · Claude + Codex`,
      `Failed · ${w[4]} · 8a8ec14 · Claude`,
    ]);
    expect(withDecisions[0]!.target).toBeNull();
    expect(itemShows(withDecisions[0]!, { kind: 'teammate', reviewId: 20 })).toBe(false);
  });

  it('splits each row into its columns; no trigger, depth or cost', () => {
    expect(reviewListCells(items[2]!)).toEqual({ outcome: 'Failed', day: dt(items[2]!.at), sha: '8a8ec14', what: 'Claude' });
    expect(reviewListCells(items[2]!).day).toMatch(/^2 Nov \d{2}:\d{2}$/);
    expect(items.every((i) => !/Auto review|Deep|Quick|US\$|% of your week/.test(reviewListLine(i)))).toBe(true);
  });

  it('lists the newest 10; the rest wait behind "Show all"', () => {
    const many = Array.from({ length: 13 }, (_, i) => i);
    expect(REVIEWS_LIST_MAX).toBe(10);
    expect(visibleReviewItems(many, false)).toEqual(many.slice(0, 10));
    expect(visibleReviewItems(many, true)).toEqual(many);
    expect(visibleReviewItems(many.slice(0, 4), false)).toHaveLength(4);
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

  it('the Story check names the ticket without linking into the tracker, and holds no "Ticket" disclosure', () => {
    const coverage = read('../src/components/TicketCoverage.tsx');
    expect(coverage).not.toContain('JiraKeyLink');
    // The PR's header links the ticket; the AI Review tab shows no collapsible copy of it (2026-11-10).
    expect(coverage).not.toContain('<StoryDisclosure');
  });
});

// EVERY FINDING LOOKS THE SAME (ClaudeReviewTab.tsx `PointFindingCard` → `FindingRow`): a teammate's
// point carries what the reader's own card shows, and keeps Copy + "Post reminder" only.
describe('the shared finding card', () => {
  const ANCHOR = 'f'.repeat(64);
  const mate = (over: Partial<ClaudeTeamPoint> = {}): ClaudeTeamPoint =>
    point(1875, {
      origin: 'teammate',
      author: byRobin,
      reviewId: 20,
      path: 'src/db/schema-check.js',
      line: 76,
      title: '`schemaErrorListener` runs only on the `request` event.',
      body: 'Hapi emits that event only for a thrown 500.',
      suggestion: 'countSchemaError(err);',
      githubUrl: 'https://github.com/acme/x/pull/1#discussion_r4468216175',
      threadId: 1200498,
      side: 'RIGHT',
      diffAnchorId: ANCHOR,
      postedAt: '2026-11-04T09:00:00Z',
      githubCommentId: '4468216175',
      postedCommentKind: 'inline',
      // Never believed on a teammate's: "Posted automatically" is the reader's own auto-post.
      postedAuto: true,
      reminder: null,
      remindable: true,
      ...over,
    });

  it("a teammate's open point: the same fields as the reader's own, Copy and Post reminder", () => {
    const c = pointCard(mate());
    expect(c.finding).toMatchObject({
      id: 1875,
      reviewId: 20,
      path: 'src/db/schema-check.js',
      line: 76,
      side: 'RIGHT',
      diffAnchorId: ANCHOR,
      severity: 'warning',
      title: '`schemaErrorListener` runs only on the `request` event.',
      body: 'Hapi emits that event only for a thrown 500.',
      suggestion: 'countSchemaError(err);',
      postedAt: '2026-11-04T09:00:00Z',
      githubCommentId: '4468216175',
      postedCommentKind: 'inline',
      postedAuto: false,
      editedBody: null,
      threadId: 1200498,
    });
    expect(c).toMatchObject({ remind: true, reason: null, unlabelled: false, headSha: SHA_A });
    // "Posted · <when>" linking the comment — never "Posted automatically".
    const post = effectivePost(c.finding);
    expect(post).toMatchObject({ githubCommentId: '4468216175', postedCommentKind: 'inline', earlier: false });
    expect(postedChipLabel(post!)).toMatch(/^Posted · /);
    // The own-card rule would hide the reminder (not the latest run); the card offers it itself.
    expect(canPostReminder(post, false)).toBe(false);
  });

  it('a closed or not-remindable teammate point: Copy only, with the reason; unlabelled hides the chip', () => {
    const closed = pointCard(mate({ state: { kind: 'resolved_on_github' }, remindable: false }));
    expect(closed).toMatchObject({ remind: false, reason: 'Resolved on GitHub' });
    // A stale `remindable` never offers it on a closed point.
    expect(pointCard(mate({ state: { kind: 'resolved_on_github' } })).remind).toBe(false);
    expect(pointCard(mate({ severity: null })).unlabelled).toBe(true);
    expect(pointCard(mate({ remindable: undefined })).remind).toBe(false);
  });

  it("the reader's own older point keeps its own post's words and no reminder", () => {
    const c = pointCard(point(3, { postedAt: '2026-11-03T10:00:00Z', githubCommentId: '55', postedCommentKind: 'inline', postedAuto: true, remindable: true }));
    expect(c.finding.postedAuto).toBe(true);
    expect(postedChipLabel(effectivePost(c.finding)!)).toMatch(/^Posted automatically · /);
    expect(c.remind).toBe(false);
  });

  it("a teammate's finding in their past review: title split from the text, the suggestion apart, read-only", () => {
    const c = teammateFindingCard(
      {
        id: 1876,
        path: 'src/routes/validate.js',
        line: 434,
        severity: 'warning',
        title: '`describeError` limits each message…',
        body: '`describeError` limits each message to 500 characters. But line 434 passes `error` too.\n\n```suggestion\nlogger.error({ err })\n```',
        kind: 'inline',
        githubUrl: null,
        threadId: 1200499,
        githubCommentId: '4468216182',
        postedAt: '2026-11-04T09:00:01Z',
        side: 'RIGHT',
        diffAnchorId: ANCHOR,
      },
      { reviewId: 20, postedAt: '2026-11-04T09:00:00Z', headSha: SHA_B },
    );
    expect(c.finding).toMatchObject({
      title: '`describeError` limits each message to 500 characters.',
      body: 'But line 434 passes `error` too.',
      suggestion: 'logger.error({ err })',
      postedAt: '2026-11-04T09:00:01Z',
      postedAuto: false,
    });
    expect(c.remind).toBe(false);
  });

  it('the card is the reader\'s own FindingRow, never editable: no Post, Reword or Ignore; no chat pin', () => {
    const tab = readFileSync(fileURLToPath(new URL('../src/components/ClaudeReviewTab.tsx', import.meta.url)), 'utf8');
    const card = tab.slice(tab.indexOf('function PointFindingCard'), tab.indexOf('function PointFindingCard') + 1500);
    expect(card).toContain('<FindingRow');
    expect(card).toContain('editable={false}');
    expect(card).toContain('card={{ unlabelled: card.unlabelled, reason: card.reason }}');
    // Post / Reword / Ignore are all `editable && …` in FindingRow.
    expect(tab).toContain('const canPostComment = editable && !isPosted;');
    expect(tab).toContain('const canIgnore = editable && !isPosted;');
    expect(tab).toContain('{editable && !isPosted && !rewording && (');
    expect(tab).toContain('{card == null && (\n              <SendToChatButton');
  });
});
