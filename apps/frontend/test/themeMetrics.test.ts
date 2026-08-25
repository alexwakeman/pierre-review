// `foldThemeMetrics` — the theme drill-down's deterministic metrics strip (D4: every number a
// client-side JS fold over data the view already fetched; the model contributes nothing).
//
// The contract under test:
//
//   • TOTALITY. The fold runs above a tree with no error boundary, over stored/served data in
//     every partial shape react-query can hand it: PR detail absent (still loading / evicted),
//     `threads` null, a thread with no comments, a derivedState the vocabulary doesn't know.
//     None of these may throw — they lower `loadedPrCount` or skip the member, disclosed by the
//     strip's "n of m PRs loaded" suffix.
//   • DEDUP. Two members citing one thread count it once (the group view dedupes the same way);
//     ML label targets are deduplicated per (kind, id).
//   • ML SILENCE. A target with no label counts toward NOTHING — `labelled` gates the chips (no
//     badge is silence, not agreement — the Inflation-column rule). major+critical bucket as
//     "high" (the product rule from docs/ML-SEVERITY.md).
//   • TARGETS. A review member's label target is the matched thread's ROOT comment under
//     'review_comment'; an issue member's is ('pr_comment', ref.commentId).
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { DerivedState, ThemeThreadRef } from '@pierre-review/shared';
import {
  foldThemeMetrics,
  type FoldableMlLabels,
  type FoldablePrDetail,
  type PrGroup,
} from '../src/components/Activity/ThemeThreadsDetail.js';

function ref(over: Partial<ThemeThreadRef> & { prId: number }): ThemeThreadRef {
  return {
    prNumber: over.prId, // any number — the fold never reads it
    repoFullName: 'acme/api',
    source: 'review',
    threadId: null,
    commentId: null,
    path: null,
    ...over,
  };
}

function group(prId: number, refs: ThemeThreadRef[]): PrGroup {
  return { prId, prNumber: prId, repoFullName: refs[0]?.repoFullName ?? 'acme/api', refs };
}

const noLabels = new Map<number, FoldableMlLabels | undefined>();

describe('foldThemeMetrics', () => {
  it('computes the ref-derived chips with nothing loaded, and states/ml stay zero', () => {
    const members = [
      ref({ prId: 1, threadId: 10 }),
      ref({ prId: 1, source: 'issue', commentId: 900 }),
      ref({ prId: 2, repoFullName: 'acme/web', threadId: 11 }),
    ];
    const m = foldThemeMetrics(
      members,
      [group(1, members.slice(0, 2)), group(2, members.slice(2))],
      new Map(),
      noLabels,
    );
    expect(m.memberCount).toBe(3);
    expect(m.reviewMembers).toBe(2);
    expect(m.issueMembers).toBe(1);
    expect(m.prCount).toBe(2);
    expect(m.repoCount).toBe(2);
    expect(m.shownPrCount).toBe(2);
    expect(m.loadedPrCount).toBe(0);
    expect(m.matchedThreads).toBe(0);
    expect(m.states).toEqual({
      untouched: 0,
      replied_unresolved: 0,
      likely_addressed: 0,
      resolved: 0,
    });
    expect(m.ml).toEqual({ high: 0, minor: 0, nit: 0, labelled: 0 });
  });

  it('tallies thread states from loaded detail, counting a twice-cited thread once', () => {
    const members = [
      ref({ prId: 1, threadId: 10 }),
      ref({ prId: 1, threadId: 10 }), // same thread cited twice — one count
      ref({ prId: 1, threadId: 11 }),
      ref({ prId: 1, threadId: 99 }), // not in the loaded detail — skipped
    ];
    const pr: FoldablePrDetail = {
      threads: [
        { id: 10, derivedState: 'resolved', comments: [{ id: 100 }] },
        { id: 11, derivedState: 'untouched', comments: [{ id: 110 }] },
      ],
    };
    const m = foldThemeMetrics(members, [group(1, members)], new Map([[1, pr]]), noLabels);
    expect(m.loadedPrCount).toBe(1);
    expect(m.matchedThreads).toBe(2);
    expect(m.states.resolved).toBe(1);
    expect(m.states.untouched).toBe(1);
    expect(m.states.replied_unresolved).toBe(0);
  });

  it('buckets ML severity (major+critical = high) off the root comment / PR comment, silent when unlabelled', () => {
    const members = [
      ref({ prId: 1, threadId: 10 }), // root 100 → critical → high
      ref({ prId: 1, threadId: 11 }), // root 110 → major → high
      ref({ prId: 1, threadId: 12 }), // root 120 → minor
      ref({ prId: 1, threadId: 13 }), // root 130 → NO label → counts toward nothing
      ref({ prId: 1, source: 'issue', commentId: 900 }), // pr_comment → nit
      ref({ prId: 1, source: 'issue', commentId: 900 }), // duplicate target — one count
    ];
    const pr: FoldablePrDetail = {
      threads: [
        { id: 10, derivedState: 'untouched', comments: [{ id: 100 }] },
        { id: 11, derivedState: 'untouched', comments: [{ id: 110 }] },
        { id: 12, derivedState: 'untouched', comments: [{ id: 120 }] },
        { id: 13, derivedState: 'untouched', comments: [{ id: 130 }] },
      ],
    };
    const labels: FoldableMlLabels = {
      labels: [
        { targetKind: 'review_comment', targetId: 100, severity: 'critical' },
        { targetKind: 'review_comment', targetId: 110, severity: 'major' },
        { targetKind: 'review_comment', targetId: 120, severity: 'minor' },
        // 130 deliberately unlabelled; a label on a REPLY must not count either:
        { targetKind: 'review_comment', targetId: 131, severity: 'critical' },
        { targetKind: 'pr_comment', targetId: 900, severity: 'nit' },
      ],
    };
    const m = foldThemeMetrics(
      members,
      [group(1, members)],
      new Map([[1, pr]]),
      new Map([[1, labels]]),
    );
    expect(m.ml).toEqual({ high: 2, minor: 1, nit: 1, labelled: 4 });
  });

  it('is total under null threads, a comment-less thread and an unknown derivedState', () => {
    const members = [
      ref({ prId: 1, threadId: 10 }),
      ref({ prId: 2, threadId: 20 }),
      ref({ prId: 3, threadId: 30 }),
    ];
    const prNullThreads: FoldablePrDetail = { threads: null };
    const prNoComments: FoldablePrDetail = {
      threads: [{ id: 20, derivedState: 'resolved' }], // no comments array at all
    };
    const prRogueState: FoldablePrDetail = {
      threads: [{ id: 30, derivedState: 'someday_new_state' as DerivedState, comments: [] }],
    };
    const m = foldThemeMetrics(
      members,
      [group(1, [members[0]!]), group(2, [members[1]!]), group(3, [members[2]!])],
      new Map([
        [1, prNullThreads],
        [2, prNoComments],
        [3, prRogueState],
      ]),
      noLabels,
    );
    expect(m.loadedPrCount).toBe(3);
    // The comment-less thread still counts its STATE (the ML target is simply absent); the
    // unknown state is skipped rather than minted a NaN bucket.
    expect(m.matchedThreads).toBe(1);
    expect(m.states.resolved).toBe(1);
    expect(m.ml.labelled).toBe(0);
  });

  it('discloses a partial load: shown 2, loaded 1', () => {
    const members = [ref({ prId: 1, threadId: 10 }), ref({ prId: 2, threadId: 20 })];
    const pr: FoldablePrDetail = {
      threads: [{ id: 10, derivedState: 'likely_addressed', comments: [{ id: 100 }] }],
    };
    const m = foldThemeMetrics(
      members,
      [group(1, [members[0]!]), group(2, [members[1]!])],
      new Map([[1, pr]]),
      noLabels,
    );
    expect(m.shownPrCount).toBe(2);
    expect(m.loadedPrCount).toBe(1);
    expect(m.states.likely_addressed).toBe(1);
  });
});
