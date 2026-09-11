import { describe, expect, it } from 'vitest';
import {
  foldFile,
  foldToText,
  type FoldFileInput,
  type ResolvedDecision,
} from '@pierre-review/shared';

// THE SHARED FOLD, RUN IN CI. `apps/frontend/test/conflictFold.test.ts` holds the same table,
// but the frontend suite is hand-run and this one is not — and the fold is the function that
// decides what BYTES get committed, so it needs a guard that runs on every push.

const TERM = { base: true, ours: true, theirs: true };

/** Two regions: an `ours_only` change, then a genuine contest. */
function twoRegionFile(
  terminators = TERM,
): FoldFileInput {
  return {
    terminators,
    regions: [
      { id: 1, kind: 'unchanged', base: ['header'], ours: [], theirs: [] },
      { id: 2, kind: 'ours_only', base: ['b-old'], ours: ['b-ours'], theirs: [] },
      { id: 3, kind: 'conflict', base: ['c-base'], ours: ['c-ours'], theirs: ['c-theirs'] },
    ],
  };
}

function decide(...pairs: [number, ResolvedDecision][]): Map<number, ResolvedDecision> {
  return new Map(pairs);
}

describe('foldFile', () => {
  it('emits every deterministic decision byte-exactly', () => {
    const file = twoRegionFile();
    const cases: [ResolvedDecision, string[]][] = [
      [{ decision: 'ours' }, ['header', 'b-ours', 'c-ours']],
      [{ decision: 'theirs' }, ['header', 'b-ours', 'c-theirs']],
      [{ decision: 'base' }, ['header', 'b-ours', 'c-base']],
      [{ decision: 'both_ours_first' }, ['header', 'b-ours', 'c-ours', 'c-theirs']],
      [{ decision: 'both_theirs_first' }, ['header', 'b-ours', 'c-theirs', 'c-ours']],
      [
        { decision: 'disjoint_merge', lines: ['c-merged'], endsWithNewline: true },
        ['header', 'b-ours', 'c-merged'],
      ],
      [
        { decision: 'suggestion', lines: ['c-model'], endsWithNewline: true },
        ['header', 'b-ours', 'c-model'],
      ],
    ];
    for (const [decision, expected] of cases) {
      const r = foldFile(file, decide([2, { decision: 'ours' }], [3, decision]));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.lines).toEqual(expected);
    }
  });

  it('distinguishes the two both-orderings', () => {
    const file = twoRegionFile();
    const a = foldFile(
      file,
      decide([2, { decision: 'ours' }], [3, { decision: 'both_ours_first' }]),
    );
    const b = foldFile(
      file,
      decide([2, { decision: 'ours' }], [3, { decision: 'both_theirs_first' }]),
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.lines).toEqual(['header', 'b-ours', 'c-ours', 'c-theirs']);
      expect(b.lines).toEqual(['header', 'b-ours', 'c-theirs', 'c-ours']);
    }
  });

  it("`base` on an `ours_only` region emits the ancestor — the revert case", () => {
    // ⚠ Asserted explicitly because this is the ONE decision that removes the PR's own work.
    const file = twoRegionFile();
    const r = foldFile(file, decide([2, { decision: 'base' }], [3, { decision: 'ours' }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['header', 'b-old', 'c-ours']);
  });

  it('takes the terminator from the LAST region’s chosen source', () => {
    const file = twoRegionFile({ base: true, ours: true, theirs: false });
    const takeTheirs = foldFile(
      file,
      decide([2, { decision: 'ours' }], [3, { decision: 'theirs' }]),
    );
    expect(takeTheirs.ok && takeTheirs.finalNewline).toBe(false);
    const takeOurs = foldFile(file, decide([2, { decision: 'ours' }], [3, { decision: 'ours' }]));
    expect(takeOurs.ok && takeOurs.finalNewline).toBe(true);
    // A both-ordering ends with the side written SECOND.
    const oursFirst = foldFile(
      file,
      decide([2, { decision: 'ours' }], [3, { decision: 'both_ours_first' }]),
    );
    expect(oursFirst.ok && oursFirst.finalNewline).toBe(false);
  });

  it('refuses a missing decision rather than defaulting one', () => {
    const file: FoldFileInput = {
      terminators: TERM,
      regions: [{ id: 7, kind: 'theirs_only', base: ['x'], ours: [], theirs: ['y'] }],
    };
    expect(foldFile(file, decide())).toEqual({
      ok: false,
      reason: 'undecided_region',
      regionId: 7,
    });
  });

  it('refuses a decision the region does not allow', () => {
    const file: FoldFileInput = {
      terminators: TERM,
      regions: [{ id: 7, kind: 'ours_only', base: ['x'], ours: ['y'], theirs: [] }],
    };
    const r = foldFile(file, decide([7, { decision: 'theirs' }]));
    expect(r).toEqual({ ok: false, reason: 'disallowed_decision', regionId: 7 });
  });

  it('refuses a decision addressing a region this file does not have', () => {
    const file: FoldFileInput = {
      terminators: TERM,
      regions: [{ id: 1, kind: 'ours_only', base: ['x'], ours: ['y'], theirs: [] }],
    };
    const r = foldFile(file, decide([1, { decision: 'ours' }], [99, { decision: 'ours' }]));
    expect(r).toEqual({ ok: false, reason: 'unknown_region', regionId: 99 });
  });

  it('round-trips an all-ours fold back to the ours side, byte for byte', () => {
    const oursText = 'header\nb-ours\nc-ours\n';
    const file = twoRegionFile();
    const r = foldFile(file, decide([2, { decision: 'ours' }], [3, { decision: 'ours' }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(foldToText(r)).toBe(oursText);
  });
});
