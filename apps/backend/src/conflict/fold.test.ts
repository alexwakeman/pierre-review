import { describe, expect, it } from 'vitest';
import {
  foldFile,
  foldToText,
  type FoldFileInput,
  type ResolvedDecision,
} from '@pierre-review/shared';

// THE SHARED FOLD, RUN IN CI — and this is its ONLY guard that runs on every push. The SPA calls
// the same function (`lib/mergeResolver.ts`'s `centreLines`, one region at a time) and
// `apps/frontend/test/mergeResolver.test.ts` exercises it from that side, but the frontend suite
// is hand-run. The fold decides what BYTES get committed, so the table lives here.

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
      [
        { decision: 'edited', lines: ['c-typed'], endsWithNewline: true },
        ['header', 'b-ours', 'c-typed'],
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

  // ── THE READER'S OWN TEXT ─────────────────────────────────────────────────────────────────
  //
  // `'edited'` is the one member that is not about a side, so it is the one member the per-kind
  // allow-list would have refused everywhere. Rule 6 hoists it; these pin the hoist, because
  // without it every hand-edited one-sided change comes back `disallowed_decision` — which
  // surfaces as `IncompleteDecisions` and refuses the WHOLE commit, naming a file the reader
  // has plainly answered.
  it('takes a hand-edited decision on EVERY decidable kind', () => {
    const kinds = ['ours_only', 'theirs_only', 'both_same', 'conflict'] as const;
    for (const kind of kinds) {
      const file: FoldFileInput = {
        terminators: TERM,
        regions: [{ id: 4, kind, base: ['b'], ours: ['o'], theirs: ['t'] }],
      };
      const r = foldFile(
        file,
        decide([4, { decision: 'edited', lines: ['typed'], endsWithNewline: true }]),
      );
      expect(r.ok, kind).toBe(true);
      if (r.ok) expect(r.lines, kind).toEqual(['typed']);
    }
  });

  it('ignores a hand-edited decision on an `unchanged` region, like every other decision', () => {
    // Rule 1 runs before the allow-list: context emits `base` whatever the map says. The EDIT
    // ROUTE is what refuses to mint a handle there in the first place (`not_editable`); this is
    // the fold agreeing rather than a second gate.
    const file: FoldFileInput = {
      terminators: TERM,
      regions: [{ id: 1, kind: 'unchanged', base: ['ctx'], ours: [], theirs: [] }],
    };
    const r = foldFile(
      file,
      decide([1, { decision: 'edited', lines: ['typed'], endsWithNewline: true }]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['ctx']);
  });

  it('takes a hand-edited LAST region’s OWN terminator, not a side’s', () => {
    // Fold rule 4. The file's three sides all end with a newline here, so a `false` coming out
    // can only have come from the decision's own flag.
    const file: FoldFileInput = {
      terminators: TERM,
      regions: [{ id: 2, kind: 'conflict', base: ['b'], ours: ['o'], theirs: ['t'] }],
    };
    const noNewline = foldFile(
      file,
      decide([2, { decision: 'edited', lines: ['typed'], endsWithNewline: false }]),
    );
    expect(noNewline.ok && noNewline.finalNewline).toBe(false);
    if (noNewline.ok) expect(foldToText(noNewline)).toBe('typed');
    const withNewline = foldFile(
      file,
      decide([2, { decision: 'edited', lines: ['typed'], endsWithNewline: true }]),
    );
    if (withNewline.ok) expect(foldToText(withNewline)).toBe('typed\n');
  });

  it('splices ZERO edited lines — deleting a whole hunk is the feature', () => {
    const file = twoRegionFile();
    const r = foldFile(
      file,
      decide(
        [2, { decision: 'ours' }],
        [3, { decision: 'edited', lines: [], endsWithNewline: true }],
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['header', 'b-ours']);
  });

  it('round-trips an all-ours fold back to the ours side, byte for byte', () => {
    const oursText = 'header\nb-ours\nc-ours\n';
    const file = twoRegionFile();
    const r = foldFile(file, decide([2, { decision: 'ours' }], [3, { decision: 'ours' }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(foldToText(r)).toBe(oursText);
  });
});
