// THE PR CHIPS (docs/FRONTEND.md § PR chips): the stacked-PR verdict ("Lands after #N") through the
// ONE merge resolver, and the chips' words. Run by hand:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { MergeStateStatus, PrBranchStack, PrCriteriaCheck } from '@pierre-review/shared';
import { landsAfterOf } from '@pierre-review/shared';
import { mergeVerdict, mergeWhenReadyEligible } from '../src/lib/ui.js';
import { criteriaChipText, stackChipLabel, stackChipTitle } from '../src/components/Activity/PrChips.js';

const m = (prId: number, number: number) => ({ prId, number, title: `PR ${number}` });
const middle: PrBranchStack = { position: 2, chain: [m(1, 10), m(2, 11), m(3, 12)], parent: m(1, 10), children: [m(3, 12)] };
const bottom: PrBranchStack = { position: 1, chain: [m(1, 10), m(2, 11), m(3, 12)], parent: null, children: [m(2, 11)] };

describe('mergeVerdict — a stacked PR lands after its parent', () => {
  for (const mss of ['clean', 'unstable', 'has_hooks', 'blocked', 'behind'] as MergeStateStatus[]) {
    it(`never offers Merge (${mss})`, () => {
      const v = mergeVerdict({ mergeable: 'mergeable', mergeStateStatus: mss, landsAfter: 10 });
      expect(v.canMerge).toBe(false);
      expect(v.verdict).toBe('blocked');
      expect(v.label).toBe('lands after #10');
      expect(v.blockers?.[0]).toMatchObject({ kind: 'lands_after', certainty: 'inferred', count: 10 });
    });
  }

  it('reads blockFacts.landsAfter too, and keeps GitHub’s own blockers under it', () => {
    const v = mergeVerdict({
      mergeable: 'mergeable',
      mergeStateStatus: 'blocked',
      blockFacts: { reviewDecision: 'review_required', landsAfter: 10 },
    });
    expect(v.blockers?.map((b) => b.kind)).toEqual(['lands_after', 'review_required']);
  });

  it('is not armable', () => {
    const v = mergeVerdict({ mergeable: 'mergeable', mergeStateStatus: 'blocked', landsAfter: 10 });
    expect(mergeWhenReadyEligible({ allowedByRepo: true, methodCount: 1, alreadyArmed: false, verdict: v, behindBy: 0 })).toBe(false);
  });

  it('the queue and conflicts still outrank it; no parent changes nothing', () => {
    expect(mergeVerdict({ mergeable: 'conflicting', mergeStateStatus: 'dirty', landsAfter: 10 }).verdict).toBe('conflicts');
    expect(mergeVerdict({ mergeable: 'mergeable', mergeStateStatus: 'clean', inMergeQueue: true, landsAfter: 10 }).verdict).toBe('queued');
    expect(mergeVerdict({ mergeable: 'mergeable', mergeStateStatus: 'clean', landsAfter: null }).canMerge).toBe(true);
  });

  it('landsAfterOf: the parent’s number, null at the bottom or with no stack', () => {
    expect(landsAfterOf(middle)).toBe(10);
    expect(landsAfterOf(bottom)).toBeNull();
    expect(landsAfterOf(null)).toBeNull();
    expect(landsAfterOf(undefined)).toBeNull();
  });
});

describe('the stack chip', () => {
  it('"2 of 3 in stack", with what lands before and after it in the title', () => {
    expect(stackChipLabel(middle)).toBe('2 of 3 in stack');
    expect(stackChipTitle(middle)).toBe('Lands after #10 (PR 10). #12 lands after this.');
    expect(stackChipLabel(bottom)).toBe('1 of 3 in stack');
  });

  it('a branch point with nothing below it names how many are stacked on it', () => {
    const s: PrBranchStack = { position: 1, chain: [m(1, 10)], parent: null, children: [m(2, 11), m(3, 12)] };
    expect(stackChipLabel(s)).toBe('2 stacked on this');
    expect(stackChipTitle(s)).toBe('#11, #12 land after this.');
  });
});

describe('the criteria chip', () => {
  const c: PrCriteriaCheck = {
    ident: 'jira:x#BMD-7',
    key: 'BMD-7',
    title: 'Story',
    reviewId: 1,
    met: 3,
    partlyMet: 0,
    notMet: 1,
    unsettled: 0,
    total: 4,
    checkedAt: new Date().toISOString(),
    olderHead: false,
  };
  it('"Criteria 3/4"; the ticket key only when the PR has several', () => {
    expect(criteriaChipText(c, false).label).toBe('Criteria 3/4');
    expect(criteriaChipText(c, true).label).toBe('BMD-7 criteria 3/4');
    expect(criteriaChipText(c, false).title).toMatch(/^BMD-7: 3 of 4 acceptance criteria met \(1 not met\)\. Checked /);
  });
  it('says when the check read an older commit', () => {
    const o = criteriaChipText({ ...c, olderHead: true }, false);
    expect(o.label).toBe('Criteria 3/4 · older commit');
    expect(o.title).toMatch(/on an older commit of this PR\.$/);
  });
});
