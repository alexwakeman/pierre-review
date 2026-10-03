// FOLLOW-UP ON THE PREVIOUS REVIEW — the pure half (claude-review/follow-up.ts).
//
// The headline rule: the server NEVER invents "addressed". Every earlier finding that was sent gets
// exactly one status — Claude's first report for its ref, or 'not_checked' — and every finding over
// the cap is 'not_checked' too, so the next review can carry it forward.
//
// Runs from the backend workspace (@pierre/pro ships no vitest devDep):
//   pnpm --filter @pierre-review/backend test claude-review-follow-up
import { describe, expect, it } from 'vitest';
import type { ClaudeFindingSeverity } from '@pierre-review/shared';
import type { ReviewFinding } from '../../pro/contract.js';
import {
  PRIOR_FINDINGS_MAX,
  findingHeadMoved,
  isAlreadyOnThisCommit,
  isFollowUpEligible,
  linkReraisedFindings,
  reconcileFollowUp,
  resolveFindingBody,
  selectPriorFindings,
  type PriorFindingForFollowUp,
  type PriorReviewForFollowUp,
} from './follow-up.js';

let nextId = 1;
function prior(over: Partial<PriorFindingForFollowUp> = {}): PriorFindingForFollowUp {
  const id = over.id ?? nextId++;
  return {
    id,
    headSha: 'a'.repeat(40),
    path: `src/f${id}.ts`,
    line: 10,
    side: 'RIGHT',
    severity: 'warning',
    title: `finding ${id}`,
    body: `body ${id}`,
    suggestion: 'fix()',
    diffHunk: '@@ -1 +1 @@\n+x',
    anchored: true,
    fileInDiff: true,
    posted: false,
    carried: false,
    ...over,
  };
}

// The previous review's OWN findings were raised at its head by construction; a CARRIED one keeps
// the (older) head it was given.
const review = (findings: PriorFindingForFollowUp[], headSha = 'a'.repeat(40)): PriorReviewForFollowUp => ({
  reviewId: 7,
  headSha,
  findings: findings.map((f) => (f.carried ? f : { ...f, headSha })),
});

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: 'src/x.ts',
    line: 3,
    side: 'RIGHT',
    severity: 'warning',
    title: 't',
    body: 'b',
    suggestion: null,
    diffHunk: null,
    anchored: true,
    fileInDiff: true,
    ...over,
  };
}

describe('eligibility', () => {
  const sev = (s: ClaudeFindingSeverity) => s;
  it('praise is never followed up, posted or not', () => {
    expect(isFollowUpEligible({ postedAt: null, severity: sev('praise') })).toBe(false);
    expect(isFollowUpEligible({ postedAt: new Date(), severity: 'praise' })).toBe(false);
  });
  it('an unposted finding is out, whatever its tick says (ignored, left unposted, only copied)', () => {
    expect(isFollowUpEligible({ postedAt: null, severity: 'blocker' })).toBe(false);
    // The included tick is not part of the rule: a row carrying it is still judged on postedAt.
    const included = { included: true, postedAt: null, severity: 'question' as const };
    expect(isFollowUpEligible(included)).toBe(false);
  });
  it('a POSTED finding is in, even if the reader ignored it afterwards (it is on the pull request)', () => {
    expect(isFollowUpEligible({ postedAt: new Date(), severity: 'nit' })).toBe(true);
    const ignoredAfter = { included: false, postedAt: new Date(), severity: 'warning' as const };
    expect(isFollowUpEligible(ignoredAfter)).toBe(true);
  });
  it('uses editedBody when set, falling back when blank', () => {
    expect(resolveFindingBody({ body: 'claude', editedBody: 'mine' })).toBe('mine');
    expect(resolveFindingBody({ body: 'claude', editedBody: '   \n' })).toBe('claude');
    expect(resolveFindingBody({ body: 'claude', editedBody: null })).toBe('claude');
  });
});

describe('selectPriorFindings', () => {
  it('orders own findings by severity then id, carried after, and hands out P refs', () => {
    const nit = prior({ id: 1, severity: 'nit' });
    const blocker = prior({ id: 2, severity: 'blocker' });
    const q = prior({ id: 3, severity: 'question' });
    const carriedBlocker = prior({ id: 4, severity: 'blocker', carried: true });
    const warning = prior({ id: 5, severity: 'warning' });
    const plan = selectPriorFindings(review([nit, blocker, q, carriedBlocker, warning]), 'b'.repeat(40));
    expect(plan.sent.map((s) => [s.ref, s.finding.id])).toEqual([
      ['P1', 2],
      ['P2', 5],
      ['P3', 3],
      ['P4', 1],
      ['P5', 4],
    ]);
    expect(plan.omitted).toEqual([]);
    expect(plan.headMoved).toBe(true);
    expect(plan.priorReviewId).toBe(7);
  });

  it('headMoved is false on the same head', () => {
    expect(selectPriorFindings(review([prior()], 'c'.repeat(40)), 'c'.repeat(40)).headMoved).toBe(false);
  });

  it(`caps the count at ${PRIOR_FINDINGS_MAX}; the rest are omitted`, () => {
    const many = Array.from({ length: 45 }, (_, i) => prior({ id: 1000 + i, body: 'x', diffHunk: null, suggestion: null }));
    const plan = selectPriorFindings(review(many), 'z');
    expect(plan.sent).toHaveLength(40);
    expect(plan.omitted).toHaveLength(5);
    expect(plan.sent[39]!.ref).toBe('P40');
  });

  it('cuts at the character budget, keeping order (everything after the first misfit is omitted)', () => {
    const big = (id: number) => prior({ id, body: 'x'.repeat(2_000), diffHunk: 'h'.repeat(1_200), suggestion: 's'.repeat(800) });
    // ~4,200+ characters each against a 24,000 budget: five fit, the sixth does not.
    const plan = selectPriorFindings(review([1, 2, 3, 4, 5, 6, 7].map((i) => big(2000 + i))), 'z');
    expect(plan.sent).toHaveLength(5);
    expect(plan.omitted.map((f) => f.id)).toEqual([2006, 2007]);
  });
});

describe('reconcileFollowUp', () => {
  const plan = selectPriorFindings(
    review([prior({ id: 11, severity: 'blocker' }), prior({ id: 12 }), prior({ id: 13, carried: true })]),
    'z',
  );
  const withOmitted = { ...plan, omitted: [prior({ id: 14 })] };

  it('first report wins, unknown refs are dropped, the unreported are not_checked', () => {
    const items = reconcileFollowUp(withOmitted, [
      { ref: 'P1', status: 'addressed', explanation: 'Fixed in a.ts.' },
      { ref: 'P1', status: 'not_addressed', explanation: 'second report ignored' },
      { ref: 'P9', status: 'addressed', explanation: 'unknown' },
      { ref: 'p3', status: 'no_longer_applies', explanation: '  Gone.  ' },
    ]);
    expect(items.map((i) => [i.ref, i.priorFindingId, i.status, i.sent, i.carried, i.explanation])).toEqual([
      ['P1', 11, 'addressed', true, false, 'Fixed in a.ts.'],
      ['P2', 12, 'not_checked', true, false, null],
      ['P3', 13, 'no_longer_applies', true, true, 'Gone.'],
      [null, 14, 'not_checked', false, false, null],
    ]);
  });

  it('NEVER produces addressed for anything unreported (undefined report ⇒ all not_checked)', () => {
    const items = reconcileFollowUp(withOmitted, undefined);
    expect(items.map((i) => i.status)).toEqual(['not_checked', 'not_checked', 'not_checked', 'not_checked']);
    expect(items.some((i) => i.status === 'addressed')).toBe(false);
  });

  it('carries the anchor, severity and title of the earlier finding', () => {
    const [first] = reconcileFollowUp(plan, []);
    expect(first).toMatchObject({ path: 'src/f11.ts', line: 10, side: 'RIGHT', severity: 'blocker', title: 'finding 11' });
  });

  it('clips a long explanation', () => {
    const [first] = reconcileFollowUp(plan, [{ ref: 'P1', status: 'addressed', explanation: 'x'.repeat(5_000) }]);
    expect(first!.explanation!.length).toBeLessThanOrEqual(1_001);
  });
});

describe('linkReraisedFindings', () => {
  const p1 = prior({ id: 21, severity: 'blocker', path: 'src/a.ts', line: 5, body: 'Earlier body.' });
  const p2 = prior({ id: 22, path: 'src/b.ts', line: 9 });
  const p3 = prior({ id: 23, path: 'src/c.ts' });

  it('links a re-raised not_addressed finding; drops a link to an addressed one; only the first per ref', () => {
    const plan = selectPriorFindings(review([p1, p2, p3]), 'z'); // P1=21 (blocker), P2=22, P3=23
    const items = reconcileFollowUp(plan, [
      { ref: 'P1', status: 'not_addressed', explanation: 'Still there.' },
      { ref: 'P2', status: 'addressed', explanation: 'Fixed.' },
      { ref: 'P3', status: 'partly_addressed', explanation: 'Half.' },
    ]);
    const out = linkReraisedFindings(
      plan,
      items,
      [
        finding({ title: 're-raise P1', priorRef: 'P1' }),
        finding({ title: 'second for P1', priorRef: 'P1' }),
        finding({ title: 'claims P2', priorRef: 'P2' }),
        finding({ title: 're-raise P3', priorRef: 'p3' }),
        finding({ title: 'ordinary' }),
      ],
      new Set(['src/a.ts']),
    );
    expect(out.map((f) => [f.title, f.priorFindingId])).toEqual([
      ['re-raise P1', 21],
      ['second for P1', null],
      ['claims P2', null],
      ['re-raise P3', 23],
      ['ordinary', null],
    ]);
  });

  it('synthesizes a finding for an open item Claude did not raise again — head moved', () => {
    const plan = selectPriorFindings(review([p1, p2]), 'z'); // head moved
    const items = reconcileFollowUp(plan, [
      { ref: 'P1', status: 'not_addressed', explanation: 'Still there.' },
      { ref: 'P2', status: 'partly_addressed', explanation: '' },
    ]);
    const out = linkReraisedFindings(plan, items, [], new Set(['src/a.ts']));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      path: 'src/a.ts',
      severity: 'blocker',
      title: p1.title,
      line: null,
      anchored: false,
      diffHunk: null,
      suggestion: null,
      fileInDiff: true,
      priorFindingId: 21,
    });
    expect(out[0]!.body).toBe('Raised in the last review and not addressed yet. Still there.\n\nEarlier body.');
    expect(out[1]).toMatchObject({ path: 'src/b.ts', fileInDiff: false, priorFindingId: 22 });
    expect(out[1]!.body).toBe(`Raised in the last review and only partly addressed.\n\n${p2.body}`);
  });

  it('synthesizes on the SAME head by copying the anchor, hunk and suggestion', () => {
    const plan = selectPriorFindings(review([p1], 'same'), 'same');
    const items = reconcileFollowUp(plan, [{ ref: 'P1', status: 'not_addressed', explanation: 'x' }]);
    const [f] = linkReraisedFindings(plan, items, [], new Set());
    expect(f).toMatchObject({
      line: 5,
      anchored: true,
      diffHunk: p1.diffHunk,
      suggestion: p1.suggestion,
      fileInDiff: true,
      priorFindingId: 21,
    });
  });

  it('does not synthesize for addressed / no_longer_applies / not_checked items', () => {
    const plan = selectPriorFindings(review([p1, p2, p3]), 'z');
    const items = reconcileFollowUp(plan, [
      { ref: 'P1', status: 'addressed', explanation: 'x' },
      { ref: 'P2', status: 'no_longer_applies', explanation: 'x' },
    ]);
    expect(linkReraisedFindings(plan, items, [], new Set())).toEqual([]);
  });
});

describe('per-finding head (a carried finding is older than the previous review)', () => {
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);
  // R1 reviewed A and raised F3 at x.ts:120; R2 reviewed B and did not report on F3, so it is
  // carried; R3 is a same-head re-run on B ("Run anyway" to add a user story).
  const own = prior({ id: 31, path: 'src/own.ts', line: 7 });
  const carriedF3 = prior({
    id: 33,
    headSha: HEAD_A,
    carried: true,
    path: 'src/x.ts',
    line: 120,
    body: 'Old body.',
    suggestion: 'applyable()',
    diffHunk: '@@ -118 +118 @@\n+old',
  });

  it('the plan says the previous review did not move, but the carried finding did', () => {
    const plan = selectPriorFindings(review([own, carriedF3], HEAD_B), HEAD_B);
    expect(plan.headMoved).toBe(false);
    expect(plan.headSha).toBe(HEAD_B);
    expect(findingHeadMoved(plan, plan.sent[0]!.finding)).toBe(false);
    expect(findingHeadMoved(plan, plan.sent[1]!.finding)).toBe(true);
  });

  it('records the flag PER ITEM', () => {
    const plan = selectPriorFindings(review([own, carriedF3], HEAD_B), HEAD_B);
    const items = reconcileFollowUp(plan, []);
    expect(items.map((i) => [i.priorFindingId, i.headMoved, i.carried])).toEqual([
      [31, false, false],
      [33, true, true],
    ]);
  });

  it('a synthesized re-raise of the carried finding drops the stale line, hunk and suggestion', () => {
    const plan = selectPriorFindings(review([own, carriedF3], HEAD_B), HEAD_B);
    const items = reconcileFollowUp(plan, [
      { ref: 'P1', status: 'not_addressed', explanation: 'Still.' },
      { ref: 'P2', status: 'not_addressed', explanation: 'Still there.' },
    ]);
    const out = linkReraisedFindings(plan, items, [], new Set(['src/x.ts', 'src/own.ts']));
    expect(out).toHaveLength(2);
    // The previous review's own finding: same head, anchor copied.
    expect(out[0]).toMatchObject({ priorFindingId: 31, line: 7, anchored: true, suggestion: 'fix()' });
    // The carried one: raised at A, now at B — nothing from head A survives.
    expect(out[1]).toMatchObject({
      priorFindingId: 33,
      path: 'src/x.ts',
      line: null,
      anchored: false,
      diffHunk: null,
      suggestion: null,
      fileInDiff: true,
    });
    // And it does not claim to be from "the last review".
    expect(out[1]!.body).toBe('Raised in an earlier review and not addressed yet. Still there.\n\nOld body.');
  });
});

describe('a re-raise of a comment already posted on this commit starts left out', () => {
  const HEAD = 'c'.repeat(40);
  const posted = prior({ id: 41, posted: true, path: 'src/p.ts', line: 4 });
  const unposted = prior({ id: 42, path: 'src/u.ts', line: 5 });

  it('isAlreadyOnThisCommit: posted AND the code has not moved since it was raised', () => {
    expect(isAlreadyOnThisCommit({ headSha: HEAD }, { headSha: HEAD, posted: true })).toBe(true);
    expect(isAlreadyOnThisCommit({ headSha: HEAD }, { headSha: 'd'.repeat(40), posted: true })).toBe(false);
    expect(isAlreadyOnThisCommit({ headSha: HEAD }, { headSha: HEAD, posted: false })).toBe(false);
  });

  it('same head: the linked re-raise AND the synthesized one are saved with included:false', () => {
    const plan = selectPriorFindings(review([posted, unposted], HEAD), HEAD);
    const postedRef = plan.sent.find((x) => x.finding.id === 41)!.ref;
    const unpostedRef = plan.sent.find((x) => x.finding.id === 42)!.ref;
    const items = reconcileFollowUp(plan, [
      { ref: postedRef, status: 'not_addressed', explanation: 'x' },
      { ref: unpostedRef, status: 'not_addressed', explanation: 'x' },
    ]);
    expect(items.find((i) => i.priorFindingId === 41)?.priorPosted).toBe(true);
    expect(items.find((i) => i.priorFindingId === 42)?.priorPosted).toBe(false);

    const linked = linkReraisedFindings(plan, items, [finding({ priorRef: postedRef })], new Set());
    expect(linked.find((f) => f.priorFindingId === 41)?.included).toBe(false);
    // The never-posted one is synthesized and stays included (no key ⇒ the writer's default).
    expect(linked.find((f) => f.priorFindingId === 42)).not.toHaveProperty('included');

    const synthesized = linkReraisedFindings(plan, items, [], new Set());
    expect(synthesized.find((f) => f.priorFindingId === 41)?.included).toBe(false);
  });

  it('moved head: the reminder is the point, so it stays included', () => {
    const plan = selectPriorFindings(review([posted], 'e'.repeat(40)), HEAD);
    const items = reconcileFollowUp(plan, [{ ref: 'P1', status: 'not_addressed', explanation: 'x' }]);
    const [f] = linkReraisedFindings(plan, items, [], new Set(['src/p.ts']));
    expect(f).not.toHaveProperty('included');
  });
});

// ⚠ ONLY NEW COMMITS MAY CHANGE A STATUS: on a run at the previous review's head (a comment-only
// re-run), the follow-up statuses are decided in code, whatever the model says.
describe('same head ⇒ statuses carry forward (the code has not moved)', () => {
  const HEAD = 'a'.repeat(40);
  const OLDER = 'c'.repeat(40);

  it('a finding raised at this head stays not_addressed even when the model says addressed', () => {
    const own = prior({ posted: true });
    const plan = selectPriorFindings(review([own], HEAD), HEAD);
    expect(plan.headMoved).toBe(false);
    const items = reconcileFollowUp(plan, [{ ref: 'P1', status: 'addressed', explanation: 'Looks fixed.' }]);
    expect(items[0]).toMatchObject({ status: 'not_addressed', statusCarried: true, sent: true, ref: 'P1' });
    expect(items[0]!.explanation).toBe('The code has not changed since this was raised.');
  });

  it('keeps the model\'s words only when it agreed with the carried status', () => {
    const own = prior({ posted: true });
    const plan = selectPriorFindings(review([own], HEAD), HEAD);
    const items = reconcileFollowUp(plan, [{ ref: 'P1', status: 'not_addressed', explanation: 'Still unchecked on line 10.' }]);
    expect(items[0]!.explanation).toBe('Still unchecked on line 10.');
  });

  it('a carried open item keeps the status the previous run gave it', () => {
    const carried = prior({
      posted: true,
      carried: true,
      headSha: OLDER,
      priorStatus: { status: 'partly_addressed', explanation: 'Half done.' },
    });
    const plan = selectPriorFindings(review([carried], HEAD), HEAD);
    const items = reconcileFollowUp(plan, [{ ref: 'P1', status: 'not_addressed', explanation: 'x' }]);
    expect(items[0]).toMatchObject({ status: 'partly_addressed', explanation: 'Half done.', statusCarried: true });
  });

  it('a carried not_checked item was never judged, so the model still is', () => {
    const carried = prior({ posted: true, carried: true, headSha: OLDER });
    const plan = selectPriorFindings(review([carried], HEAD), HEAD);
    const items = reconcileFollowUp(plan, [{ ref: 'P1', status: 'addressed', explanation: 'Gone.' }]);
    expect(items[0]).toMatchObject({ status: 'addressed' });
    expect(items[0]!.statusCarried).toBeUndefined();
  });

  it('a MOVED head locks nothing', () => {
    const own = prior({ posted: true });
    const plan = selectPriorFindings(review([own], OLDER), HEAD);
    expect(plan.locked.size).toBe(0);
    const items = reconcileFollowUp(plan, [{ ref: 'P1', status: 'addressed', explanation: 'Fixed.' }]);
    expect(items[0]).toMatchObject({ status: 'addressed' });
  });

  it('an item over the cap keeps its locked status and is still raised again (saved left out)', () => {
    const many = Array.from({ length: PRIOR_FINDINGS_MAX + 1 }, () => prior({ posted: true }));
    const plan = selectPriorFindings(review(many, HEAD), HEAD);
    expect(plan.omitted).toHaveLength(1);
    const items = reconcileFollowUp(plan, []);
    const over = items.find((i) => !i.sent)!;
    expect(over).toMatchObject({ ref: null, status: 'not_addressed', statusCarried: true });
    const linked = linkReraisedFindings(plan, items, [], new Set());
    const reraise = linked.find((f) => f.priorFindingId === over.priorFindingId)!;
    expect(reraise).toBeDefined();
    // Already posted on this same commit: never posted twice.
    expect(reraise.included).toBe(false);
  });
});
