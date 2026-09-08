// The PR Overview's dedicated "Conflicts" row, and the ONE rule it stands on: THE GATE IS THE
// RESOLVED VERDICT, NEVER THE RAW COLUMNS.
//
// WHAT THIS PINS, and why each is worth an assertion rather than a comment:
//
//   1. `mergeVerdict` ORs the two conflict columns. `mergeStateStatus === 'dirty'` and
//      `mergeable === 'conflicting'` are separate observations that agree on real rows but not
//      always — either alone opens the row, and neither is allowed to be the whole test.
//   2. ⚠ THE QUEUE PIN. `mergeVerdict` puts `inMergeQueue` ABOVE its conflict branch on purpose:
//      GitHub owns the landing of a queued PR. A gate spelled
//      `pr.mergeStateStatus === 'dirty' || pr.mergeable === 'conflicting'` type-checks perfectly
//      and renders a Conflicts row UNDERNEATH a Status row saying "in merge queue" — two
//      contradicting answers to "can this land?" on one screen, which is the exact defect the
//      queue chip's replacement rule was added to prevent. That is the regression this file
//      exists for, and nothing else in the SPA would catch it.
//   3. `pr.state === 'open'` GATES EVERY MERGE CLAIM. `sync/upsert.ts` writes `mergeStateStatus`
//      and `mergeable` regardless of state, so a PR merged six months ago still carries `dirty`
//      and would grow a row telling the reader to go and fix a landed PR.
//   4. CONFLICTS OUTRANK DRAFT, deliberately — a conflicting draft still needs a human.
//   5. SILENCE IS NOT A CONFLICT. GitHub computes mergeability asynchronously and briefly reports
//      nothing; `unknown` + `unknown` must keep the row shut.
//   6. THE STATUS ROW SUPPRESSES ITS `· detail` ECHO FOR THIS ONE VERDICT. That suppression and
//      this gate read the same resolver, so the verdict's `detail` string is pinned here: re-word
//      it and this test names the row that now hides it.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { MergeStateStatus, MergeVerdict, Mergeable, PrState } from '@pierre-review/shared';
import { conflictsRowVisible, mergeVerdict } from '../src/lib/ui.js';

/** The merge facts ChecksTab hands the resolver, and only those.
 *
 *  ⚠ `autoMergeArmed` is deliberately absent: ChecksTab passes `mergeable`, `mergeStateStatus`,
 *  `isDraft`, `inMergeQueue` and `blockFacts` — the queue is the ONE out-of-band state that can
 *  reach this row, which is why it is the one pinned below. */
function verdictOf(
  over: {
    mergeable?: Mergeable;
    mergeStateStatus?: MergeStateStatus;
    isDraft?: boolean;
    inMergeQueue?: boolean;
  } = {},
): MergeVerdict {
  return mergeVerdict({
    // 'unknown' on BOTH columns is the honest default — "we have not been told", never "fine".
    mergeable: over.mergeable ?? 'unknown',
    mergeStateStatus: over.mergeStateStatus ?? 'unknown',
    isDraft: over.isDraft,
    inMergeQueue: over.inMergeQueue,
  }).verdict;
}

/** The row as the pane renders it: the resolved verdict, gated on the PR's state. */
const rowFor = (state: PrState, over: Parameters<typeof verdictOf>[0] = {}): boolean =>
  conflictsRowVisible(state, verdictOf(over));

describe('the Conflicts row opens on either mint arm', () => {
  it('opens on GitHub’s protection-aware state alone', () => {
    expect(verdictOf({ mergeStateStatus: 'dirty', mergeable: 'unknown' })).toBe('conflicts');
    expect(rowFor('open', { mergeStateStatus: 'dirty', mergeable: 'unknown' })).toBe(true);
  });

  it('opens on `mergeable: conflicting` alone, with the state still uncomputed', () => {
    // The second arm, and the one a raw single-column gate would miss: GitHub can answer the
    // cheap mergeability question before it answers the protection-aware one.
    expect(verdictOf({ mergeable: 'conflicting', mergeStateStatus: 'unknown' })).toBe('conflicts');
    expect(rowFor('open', { mergeable: 'conflicting', mergeStateStatus: 'unknown' })).toBe(true);
  });

  it('opens when GitHub’s own state says something ELSE entirely', () => {
    // The shape the Pending board's `conflictsStateChip` exists for: `blocked` beside
    // `conflicting`. The conflict branch runs before the blocked one, so the row still opens.
    expect(rowFor('open', { mergeable: 'conflicting', mergeStateStatus: 'blocked' })).toBe(true);
    expect(rowFor('open', { mergeable: 'conflicting', mergeStateStatus: 'behind' })).toBe(true);
  });
});

describe('⚠ THE QUEUE PIN — a queued PR gets ONE answer, and GitHub owns it', () => {
  it('resolves a conflicting, QUEUED pull request to `queued`, so the row is CLOSED', () => {
    // THE REGRESSION. Both raw columns say "conflicts" and the row must still not render: the
    // Status row above is printing the queue chip, and a second answer underneath it is exactly
    // the contradiction the one-resolver rule prevents. A gate re-reading
    // `mergeStateStatus === 'dirty' || mergeable === 'conflicting'` passes every other assertion
    // in this file and fails only this one.
    const verdict = verdictOf({
      mergeStateStatus: 'dirty',
      mergeable: 'conflicting',
      inMergeQueue: true,
    });
    expect(verdict).toBe('queued');
    expect(conflictsRowVisible('open', verdict)).toBe(false);
    expect(rowFor('open', { mergeStateStatus: 'dirty', inMergeQueue: true })).toBe(false);
  });

  it('⚠ only a POSITIVE queue observation closes it — not-queued and not-observed both open it', () => {
    // ChecksTab spells the null policy as `inMergeQueue: pr.inMergeQueue === true`, so a PR
    // synced before the column existed must not silently lose its Conflicts row.
    expect(rowFor('open', { mergeStateStatus: 'dirty', inMergeQueue: false })).toBe(true);
    expect(rowFor('open', { mergeStateStatus: 'dirty' })).toBe(true);
  });
});

describe('a landed or abandoned PR claims nothing', () => {
  it('⚠ stays shut on BOTH terminal states, however dirty the stored columns are', () => {
    // `mergeStateStatus`/`mergeable` are written by the sync regardless of state, so the stale
    // value survives the merge. The helper takes `state` as an explicit argument precisely so
    // this cannot be forgotten at the call site.
    for (const state of ['merged', 'closed'] as const) {
      expect(rowFor(state, { mergeStateStatus: 'dirty' }), state).toBe(false);
      expect(rowFor(state, { mergeable: 'conflicting' }), state).toBe(false);
    }
  });
});

describe('a conflicting DRAFT still needs a human', () => {
  it('opens the row, because conflicts outrank draft in the resolver', () => {
    expect(verdictOf({ mergeStateStatus: 'dirty', isDraft: true })).toBe('conflicts');
    expect(rowFor('open', { mergeStateStatus: 'dirty', isDraft: true })).toBe(true);
    // …and a draft with nothing wrong with it is still just a draft.
    expect(verdictOf({ mergeStateStatus: 'clean', mergeable: 'mergeable', isDraft: true })).toBe(
      'draft',
    );
    expect(
      rowFor('open', { mergeStateStatus: 'clean', mergeable: 'mergeable', isDraft: true }),
    ).toBe(false);
  });
});

describe('every other verdict leaves the row shut', () => {
  it('stays shut for every non-conflicting merge state on an open PR', () => {
    for (const mss of [
      'clean',
      'blocked',
      'behind',
      'unstable',
      'has_hooks',
      'unknown',
    ] as MergeStateStatus[]) {
      const verdict = verdictOf({ mergeStateStatus: mss, mergeable: 'mergeable' });
      expect(verdict, mss).not.toBe('conflicts');
      expect(rowFor('open', { mergeStateStatus: mss, mergeable: 'mergeable' }), mss).toBe(false);
    }
  });

  it('⚠ SILENCE IS NOT A CONFLICT — unknown + unknown says nothing', () => {
    // GitHub computes mergeability asynchronously and briefly reports nothing at all. A row that
    // read that as a conflict would fire on every freshly-pushed PR in the app.
    expect(verdictOf({ mergeable: 'unknown', mergeStateStatus: 'unknown' })).toBe('unknown');
    expect(rowFor('open', { mergeable: 'unknown', mergeStateStatus: 'unknown' })).toBe(false);
  });

  it('is closed for every member of the verdict union except `conflicts`', () => {
    // The helper takes a resolved verdict, so the whole union can be swept directly — a new
    // verdict member added upstream lands here rather than on a screen.
    const verdicts: MergeVerdict[] = [
      'clean',
      'blocked',
      'conflicts',
      'behind',
      'unstable',
      'queued',
      'armed',
      'draft',
      'unknown',
    ];
    for (const v of verdicts) {
      expect(conflictsRowVisible('open', v), v).toBe(v === 'conflicts');
    }
  });
});

describe('the Status row’s suppression and this gate read the SAME sentence', () => {
  it('pins the conflicts verdict’s label and detail', () => {
    // ChecksTab suppresses `· {verdict.detail}` on the Status row for this ONE verdict, because
    // the row below carries the action. If anyone re-words the detail, this assertion names the
    // row that is now hiding it — and `label` is pinned beside it because the red chip still
    // prints that word, one line above the row.
    const info = mergeVerdict({ mergeable: 'conflicting', mergeStateStatus: 'dirty' });
    expect(info.verdict).toBe('conflicts');
    expect(info.label).toBe('conflicts');
    expect(info.detail).toBe('resolve the conflicts with the base branch');
    expect(info.canMerge).toBe(false);
    expect(info.tone).toBe('bad');
    // ⚠ AND NO `blockers` ARRAY. `blockers[]` is populated for `blocked` ONLY; giving the
    // conflicts verdict one "for consistency with the Blocked row" is the tempting refactor.
    expect(info.blockers).toBeUndefined();
  });
});
