// The dedicated "Merge when ready" button's visibility predicate.
//
// What this pins: the button appears ONLY while arming would do something a plain Merge
// doesn't — a self-clearing blocker (blocked / behind / unknown) or clean-but-behind
// (mergeable now, behindBy > 0 → arm = update from trunk, then land). The landmine it
// guards: behindBy > 0 is true of MOST healthy PRs and may only WIDEN this button's
// eligibility — it must never flip verdict.canMerge (the plain Merge button's gate), and it
// must never resurrect the button under conflicts / a queue / a draft / an existing intent.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { mergeVerdict, mergeWhenReadyEligible, type MergeVerdictInput } from '../src/lib/ui.js';

// Build the verdict THROUGH the real resolver, not by hand — the predicate and mergeVerdict
// must stay one vocabulary, so the tests pin the whole pipeline from raw GitHub-ish state.
const verdictOf = (input: Partial<MergeVerdictInput>) =>
  mergeVerdict({ mergeable: 'mergeable', mergeStateStatus: 'unknown', ...input });

const base = {
  allowedByRepo: true,
  methodCount: 2,
  queueEnabled: false,
  alreadyArmed: false,
  behindBy: 0,
};

describe('mergeWhenReadyEligible', () => {
  it('offers the button while a self-clearing blocker is in the way', () => {
    expect(
      mergeWhenReadyEligible({ ...base, verdict: verdictOf({ mergeStateStatus: 'blocked' }) }),
    ).toBe(true);
    expect(
      mergeWhenReadyEligible({
        ...base,
        verdict: verdictOf({ mergeStateStatus: 'behind' }),
        behindBy: 3,
      }),
    ).toBe(true);
    expect(
      mergeWhenReadyEligible({ ...base, verdict: verdictOf({ mergeStateStatus: 'unknown' }) }),
    ).toBe(true);
  });

  it('offers it on a clean-but-behind PR — the update-then-merge case', () => {
    const clean = verdictOf({ mergeStateStatus: 'clean' });
    // behindBy must not have poisoned the verdict: the plain Merge button stays live.
    expect(clean.canMerge).toBe(true);
    expect(mergeWhenReadyEligible({ ...base, verdict: clean, behindBy: 2 })).toBe(true);
    // unstable is mergeable-now too (only non-required checks red) — same carve-out.
    expect(
      mergeWhenReadyEligible({
        ...base,
        verdict: verdictOf({ mergeStateStatus: 'unstable' }),
        behindBy: 1,
      }),
    ).toBe(true);
  });

  it('is ABSENT on a fully clean, up-to-date PR (arming there is just a delayed merge)', () => {
    expect(
      mergeWhenReadyEligible({ ...base, verdict: verdictOf({ mergeStateStatus: 'clean' }) }),
    ).toBe(false);
    expect(
      mergeWhenReadyEligible({ ...base, verdict: verdictOf({ mergeStateStatus: 'unstable' }) }),
    ).toBe(false);
  });

  it('is ABSENT on conflicts — the only exit (a fix-push) would disarm the intent', () => {
    const conflicts = verdictOf({ mergeable: 'conflicting', mergeStateStatus: 'dirty' });
    expect(mergeWhenReadyEligible({ ...base, verdict: conflicts })).toBe(false);
    // behindBy is meaningless under conflicts and must not resurrect the button.
    expect(mergeWhenReadyEligible({ ...base, verdict: conflicts, behindBy: 4 })).toBe(false);
  });

  it('is ABSENT on drafts, even a draft that is also behind', () => {
    expect(
      mergeWhenReadyEligible({
        ...base,
        verdict: verdictOf({ mergeStateStatus: 'blocked', isDraft: true }),
      }),
    ).toBe(false);
    expect(
      mergeWhenReadyEligible({
        ...base,
        verdict: verdictOf({ mergeStateStatus: 'behind', isDraft: true }),
        behindBy: 2,
      }),
    ).toBe(false);
  });

  it('yields to a merge queue and to an existing intent', () => {
    const blocked = verdictOf({ mergeStateStatus: 'blocked' });
    expect(mergeWhenReadyEligible({ ...base, queueEnabled: true, verdict: blocked })).toBe(false);
    // A QUEUED PR stays hidden even if the repo-level queue flag were missed — 'queued' is
    // not a wait verdict and reports canMerge:false.
    expect(
      mergeWhenReadyEligible({
        ...base,
        verdict: verdictOf({ mergeStateStatus: 'blocked', inMergeQueue: true }),
      }),
    ).toBe(false);
    expect(mergeWhenReadyEligible({ ...base, alreadyArmed: true, verdict: blocked })).toBe(false);
  });

  it('needs repo permission and at least one allowed merge method', () => {
    const blocked = verdictOf({ mergeStateStatus: 'blocked' });
    expect(mergeWhenReadyEligible({ ...base, allowedByRepo: false, verdict: blocked })).toBe(false);
    expect(mergeWhenReadyEligible({ ...base, methodCount: 0, verdict: blocked })).toBe(false);
  });
});
