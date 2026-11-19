// THE PR'S EARLIER FINDINGS IN AI FIX'S REVIEW LOOP (loop-pr-prior.ts), the pure half. Pinned:
//   • a PR finding rides the loop NEGATED and CARRIED, after the loop's own round; with no loop round the PR's
//     review anchors the record;
//   • the import takes ONLY the negated items, ids restored, lead half first, one item per finding;
//   • a loop finding's link survives to the PR only when it re-raises a PR finding.
import { describe, expect, it } from 'vitest';
import type { ClaudeFollowUpItemRecord, ClaudeReviewFollowUpRecord } from '@pierre-review/shared';
import type { PriorFindingForFollowUp, PriorReviewForFollowUp } from '../../review/claude-review/follow-up.js';
import { isPrFindingRef, mergePrPrior, prFollowUpForImport, prPriorFindingIdOf } from './loop-pr-prior.js';

const finding = (id: number, over: Partial<PriorFindingForFollowUp> = {}): PriorFindingForFollowUp => ({
  id,
  headSha: 'a'.repeat(40),
  path: 'a.ts',
  line: 3,
  side: 'RIGHT',
  severity: 'warning',
  title: `F${id}`,
  body: 'b',
  suggestion: null,
  diffHunk: null,
  anchored: true,
  fileInDiff: true,
  posted: true,
  carried: false,
  ...over,
});

const item = (priorFindingId: number, status: ClaudeFollowUpItemRecord['status'], over: Partial<ClaudeFollowUpItemRecord> = {}): ClaudeFollowUpItemRecord => ({
  ref: 'P1',
  priorFindingId,
  sent: true,
  carried: false,
  status,
  explanation: 'x',
  path: 'a.ts',
  line: 3,
  side: 'RIGHT',
  severity: 'warning',
  title: 't',
  headMoved: true,
  ...over,
});

const fu = (items: ClaudeFollowUpItemRecord[]): ClaudeReviewFollowUpRecord => ({ priorReviewId: 1, priorHeadSha: 'l'.repeat(40), headMoved: true, changesSinceShown: false, items });

describe('mergePrPrior', () => {
  const pr: PriorReviewForFollowUp = { reviewId: 2029, headSha: 'p'.repeat(40), findings: [finding(2644), finding(2645, { carried: true })] };

  it('appends the PR findings negated and carried after the loop round, which keeps the anchor', () => {
    const loop: PriorReviewForFollowUp = { reviewId: 5, headSha: 'l'.repeat(40), findings: [finding(1)] };
    const out = mergePrPrior(loop, pr)!;
    expect(out.reviewId).toBe(5);
    expect(out.headSha).toBe('l'.repeat(40));
    expect(out.findings.map((f) => [f.id, f.carried])).toEqual([
      [1, false],
      [-2644, true],
      [-2645, true],
    ]);
    // The source rows are untouched.
    expect(pr.findings[0]!.id).toBe(2644);
  });

  it('with no loop round (round 1) the PR review anchors the record', () => {
    const out = mergePrPrior(null, pr)!;
    expect(out.reviewId).toBe(2029);
    expect(out.findings.map((f) => f.id)).toEqual([-2644, -2645]);
  });

  it('no PR findings ⇒ the loop round as it was (or null)', () => {
    const loop: PriorReviewForFollowUp = { reviewId: 5, headSha: 'l'.repeat(40), findings: [finding(1)] };
    expect(mergePrPrior(loop, null)).toBe(loop);
    expect(mergePrPrior(loop, { ...pr, findings: [] })).toBe(loop);
    expect(mergePrPrior(null, null)).toBeNull();
  });
});

describe('prFollowUpForImport', () => {
  const prior = { reviewId: 2029, headSha: 'p'.repeat(40) };

  it('keeps only the PR items, ids restored and carried, anchored on the PR review', () => {
    const out = prFollowUpForImport([{ pairRole: null, followUp: fu([item(1, 'not_addressed'), item(-2644, 'addressed'), item(-2645, 'not_addressed')]) }], prior)!;
    expect(out).toMatchObject({ priorReviewId: 2029, priorHeadSha: 'p'.repeat(40), headMoved: true });
    expect(out.items.map((i) => [i.priorFindingId, i.status, i.carried])).toEqual([
      [2644, 'addressed', true],
      [2645, 'not_addressed', true],
    ]);
  });

  it('a pair: the lead half first, one item per finding (the lead’s word wins)', () => {
    const out = prFollowUpForImport(
      [
        { pairRole: 'second', followUp: fu([item(-2644, 'not_addressed'), item(-2700, 'addressed')]) },
        { pairRole: 'first', followUp: fu([item(-2644, 'addressed')]) },
      ],
      prior,
    )!;
    expect(out.items.map((i) => [i.priorFindingId, i.status])).toEqual([
      [2644, 'addressed'],
      [2700, 'addressed'],
    ]);
  });

  it('null when the round judged no PR finding, or no PR review was found', () => {
    expect(prFollowUpForImport([{ pairRole: null, followUp: fu([item(1, 'addressed')]) }], prior)).toBeNull();
    expect(prFollowUpForImport([{ pairRole: null, followUp: null }], prior)).toBeNull();
    expect(prFollowUpForImport([{ pairRole: null, followUp: fu([item(-2644, 'addressed')]) }], null)).toBeNull();
  });
});

describe('the id spaces', () => {
  it('only a negative id is a PR finding; a loop-only link is dropped for the PR', () => {
    expect(isPrFindingRef(-3)).toBe(true);
    expect(isPrFindingRef(3)).toBe(false);
    expect(isPrFindingRef(null)).toBe(false);
    expect(prPriorFindingIdOf(-2644)).toBe(2644);
    expect(prPriorFindingIdOf(7)).toBeNull();
    expect(prPriorFindingIdOf(null)).toBeNull();
  });
});
