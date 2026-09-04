// The blocked-reason derivation — the answer to "GitHub says blocked; blocked BY WHAT?".
//
// The whole feature is a promise about honesty, so these tests are mostly about what the copy
// must NOT say. GitHub collapses at least six protection failures into one word and the field
// that would separate them (`branchProtectionRule`) is admin-only, so every entry is either
// PROVEN (GitHub's own `reviewDecision` names the unmet requirement) or INFERRED (a fact of the
// PR, offered as a possibility). A confident wrong reason is worse than "blocked".
//
// ⚠ This directory does NOT run in CI (`pnpm test` is recursive vitest and the frontend's test
// script echoes "no tests"). Run it by hand:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { MergeBlockFacts, MergeStateStatus } from '@pierre-review/shared';
import { deriveMergeBlockers, mergeVerdict } from '../src/lib/ui.js';

const kinds = (f: MergeBlockFacts): string[] => deriveMergeBlockers(f).map((b) => b.kind);
const byKind = (f: MergeBlockFacts, kind: string) =>
  deriveMergeBlockers(f).find((b) => b.kind === kind);

const blocked = (blockFacts?: MergeBlockFacts) =>
  mergeVerdict({
    mergeable: 'mergeable',
    mergeStateStatus: 'blocked' as MergeStateStatus,
    ...(blockFacts ? { blockFacts } : {}),
  });

describe('deriveMergeBlockers', () => {
  it('never returns an empty list — a blocked PR always gets at least "we cannot see why"', () => {
    // The measured shape this exists for: 17 real PRs are approved + blocked with no unresolved
    // thread and no red rollup. Falling back to a bare "blocked" is what the feature replaces.
    expect(kinds({})).toEqual(['unexplained']);
    expect(kinds({ reviewDecision: null, ciStatus: 'success', unresolvedThreads: 0 })).toEqual([
      'unexplained',
    ]);
  });

  it('does NOT claim "required checks aren’t passing" on an approved PR with a green rollup', () => {
    // THE REPAIRED LIE. The predecessor switched on `reviewDecision` alone and returned
    // "required checks aren’t passing" for every approved+blocked PR — false on 10 measured PRs
    // whose CI rollup was green, from a field that says nothing about checks at all.
    const found = deriveMergeBlockers({
      reviewDecision: 'approved',
      ciStatus: 'success',
      unresolvedThreads: 0,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('unexplained');
    for (const b of found) {
      expect(b.text).not.toMatch(/checks aren.t passing|required checks are/i);
    }
    // And it uses the approval: it says the review half is done rather than shrugging.
    expect(found[0]!.text).toMatch(/approved/i);
  });

  it('marks only reviewDecision-derived entries as proven', () => {
    expect(byKind({ reviewDecision: 'review_required' }, 'review_required')!.certainty).toBe(
      'proven',
    );
    expect(
      byKind({ reviewDecision: 'changes_requested' }, 'changes_requested')!.certainty,
    ).toBe('proven');
    for (const f of [
      { ciStatus: 'failure' } as MergeBlockFacts,
      { ciStatus: 'pending' } as MergeBlockFacts,
      { unresolvedThreads: 3 } as MergeBlockFacts,
      {} as MergeBlockFacts,
    ]) {
      for (const b of deriveMergeBlockers(f)) expect(b.certainty).toBe('inferred');
    }
  });

  it('counts unresolved threads as !isResolved and names the likely-addressed subset', () => {
    // `likely_addressed` is OUR guess that a commit touched the file; GitHub still wants the
    // resolve click, so those threads are still in the blocking population. Both numbers appear
    // in one sentence precisely so this count and the Bots row's narrower one can't be confused.
    const b = byKind({ unresolvedThreads: 4, likelyAddressedThreads: 1 }, 'unresolved_threads')!;
    expect(b.count).toBe(4);
    expect(b.text).toContain('4 review threads aren’t resolved on GitHub');
    expect(b.text).toContain('1 of them look addressed');
  });

  it('never lets the likely-addressed subset exceed the unresolved count', () => {
    const b = byKind({ unresolvedThreads: 2, likelyAddressedThreads: 9 }, 'unresolved_threads')!;
    expect(b.text).toContain('2 of them look addressed');
  });

  it('hedges the thread claim — the repo setting that would prove it is unreadable', () => {
    const b = byKind({ unresolvedThreads: 2 }, 'unresolved_threads')!;
    // ⚠ CERTAINTY STILL EXISTS AND STILL ORDERS THE LIST — it is simply not narrated on screen.
    // The hedge used to be a `note` under the row explaining that the repo setting which would
    // prove this is admin-only. That explanation was removed as verbiage; what protects the reader
    // now is the TEXT never asserting causation, which is the assertion below.
    expect(b.certainty).toBe('inferred');
    // It must never assert causation.
    expect(b.text).not.toMatch(/block|prevent/i);
  });

  it('singularises', () => {
    expect(byKind({ unresolvedThreads: 1 }, 'unresolved_threads')!.text).toBe(
      '1 review thread isn’t resolved on GitHub',
    );
  });

  it('offers a red rollup with the reason that inference is sound, never as a fact', () => {
    const b = byKind({ ciStatus: 'failure' }, 'checks_red')!;
    // The auto-merge runner's argument, reused rather than re-invented: a red NON-required check
    // on its own reads as 'unstable', not 'blocked'. It rides `certainty`, which orders the list;
    // it is no longer spelled out under the row.
    expect(b.certainty).toBe('inferred');
    expect(byKind({ ciStatus: 'error' }, 'checks_red')!.text).toContain('errored');
  });

  it('separates "still running" from "registered and never reported"', () => {
    expect(byKind({ ciStatus: 'pending' }, 'checks_pending')!.text).toBe('checks are still running');
    expect(byKind({ ciStatus: 'expected' }, 'checks_pending')!.text).toBe(
      'a required check hasn’t reported yet',
    );
    // Red and pending are mutually exclusive readings of one rollup — never both.
    expect(kinds({ ciStatus: 'failure' })).toEqual(['checks_red']);
    expect(kinds({ ciStatus: 'success' })).toEqual(['unexplained']);
  });

  it('never turns an outstanding review request into a blocker of its own', () => {
    // GitHub answers `reviewDecision: null` when the base branch requires NO review — the shape
    // 1,430 of 1,552 open PRs are in. "Somebody was asked and hasn't answered" would be a false
    // cause there, so the count only ever NAMES a proven review blocker.
    expect(kinds({ reviewDecision: null, requestedReviewers: 3 })).toEqual(['unexplained']);
    expect(kinds({ reviewDecision: 'approved', requestedReviewers: 3 })).toEqual(['unexplained']);
    const b = byKind({ reviewDecision: 'review_required', requestedReviewers: 3 }, 'review_required')!;
    expect(b.count).toBe(3);
  });

  it('ranks GitHub’s own naming above every inference, and threads below the rollup', () => {
    expect(
      kinds({
        reviewDecision: 'review_required',
        ciStatus: 'failure',
        unresolvedThreads: 2,
      }),
    ).toEqual(['review_required', 'checks_red', 'unresolved_threads']);
    // Only 89 of 572 blocked PRs in a real database have ANY unresolved thread, so threads must
    // not lead just because they are the complaint that prompted the feature.
    expect(kinds({ ciStatus: 'pending', unresolvedThreads: 2 })).toEqual([
      'checks_pending',
      'unresolved_threads',
    ]);
  });

  it('drops `unexplained` the moment anything real fires', () => {
    expect(kinds({ unresolvedThreads: 1 })).toEqual(['unresolved_threads']);
    expect(kinds({ reviewDecision: 'changes_requested' })).toEqual(['changes_requested']);
  });
});

describe('mergeVerdict + blockers', () => {
  it('populates blockers ONLY for blocked, and only when facts were supplied', () => {
    expect(blocked().blockers).toBeUndefined();
    expect(blocked().detail).toBe('required checks or reviews aren’t satisfied');
    expect(blocked({ unresolvedThreads: 2 }).blockers).toHaveLength(1);
    // Every other verdict is already a complete sentence about itself.
    for (const mss of ['clean', 'dirty', 'behind', 'unstable', 'has_hooks', 'unknown'] as const) {
      const v = mergeVerdict({
        mergeable: 'mergeable',
        mergeStateStatus: mss,
        blockFacts: { unresolvedThreads: 5 },
      });
      expect(v.blockers).toBeUndefined();
    }
    expect(
      mergeVerdict({
        mergeable: 'mergeable',
        mergeStateStatus: 'blocked',
        isDraft: true,
        blockFacts: { unresolvedThreads: 5 },
      }).blockers,
    ).toBeUndefined();
  });

  it('leads with the top-ranked blocker so the one-line detail can never outrun the evidence', () => {
    expect(blocked({ reviewDecision: 'changes_requested' }).detail).toBe(
      'a reviewer requested changes',
    );
    expect(blocked({ reviewDecision: 'approved', ciStatus: 'success' }).detail).toBe(
      'approved, and nothing we can see explains the block',
    );
    expect(blocked({ ciStatus: 'success', unresolvedThreads: 3 }).detail).toBe(
      '3 review threads aren’t resolved on GitHub',
    );
  });

  it('keeps canMerge false — the list explains a block, it never softens one', () => {
    expect(blocked({ ciStatus: 'success', unresolvedThreads: 0 }).canMerge).toBe(false);
    expect(blocked({ reviewDecision: 'approved' }).canMerge).toBe(false);
    expect(blocked({ reviewDecision: 'approved' }).tone).toBe('bad');
  });

  // ⚠ REGRESSION PIN — a facts-less surface must not manufacture a blocked reason out of silence.
  // `GET /api/prs/:id/merge-options` always emits `reviewDecision`, and GitHub answers `null` for
  // every repository that requires no review. The Pending board mounts MergeControl and
  // MergeWhenReadyControl WITHOUT `blockFacts` on purpose (nothing on the board may fetch), so a
  // trigger of `reviewDecision !== undefined` fired on every PR and handed this fold
  // `{reviewDecision: null}` with no CI status and no thread count — from which the only possible
  // answer is "nothing we can see explains it". That was false for 261 of 573 open blocked PRs on
  // real data, and it contradicted the PR pane's own line for the same PR. The controls now trigger
  // on `!= null`; this pins the fold's half of the contract.
  it('a bare null review decision is silence, not evidence — it may not stand in for a cause', () => {
    // The exact object the old trigger built on a facts-less surface.
    expect(kinds({ reviewDecision: null })).toEqual(['unexplained']);
    // ...which is why the CALLER must not build it. A named decision is different: it is a
    // PROVEN row and is worth admitting on its own.
    expect(kinds({ reviewDecision: 'changes_requested' })).toEqual(['changes_requested']);
    expect(kinds({ reviewDecision: 'review_required' })).toEqual(['review_required']);
  });
});
