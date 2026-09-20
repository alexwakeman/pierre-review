import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ConflictDecision,
  ConflictFileEntry,
  ConflictRegion,
  ConflictRegionKind,
} from '@pierre-review/shared';
import {
  centreLines,
  fileRowState,
  panePaint,
  ribbonSides,
  serializeFileDecisions,
  sideOffered,
  slotFor,
  slotRole,
  tallyFile,
  wandPlan,
  wandSentence,
} from '../src/lib/mergeResolver.js';
import { useConflictResolverStore } from '../src/store/conflictResolver.js';

// ── THE RESOLVER'S ARITHMETIC ────────────────────────────────────────────────────────────────
//
// ⚠ THIS SUITE DOES NOT RUN IN CI AND IS NOT TYPECHECKED (`pnpm test` is recursive vitest and the
// frontend's `test` script is a no-op; its tsconfig includes only `src`). Run it by hand:
//     ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
//
// What is pinned here is everything that decides what lands in somebody's repository: the wand's
// promise never to pick a side, the sentence it prints, the difference between "ignored" and
// "nobody answered", and the shape of the commit body.

const R = (
  id: number,
  kind: ConflictRegionKind,
  parts: {
    base?: string[];
    ours?: string[];
    theirs?: string[];
    allowed?: ConflictDecision[];
    defaultDecision?: ConflictDecision;
    wand?: ConflictRegion['wand'];
    mergedLines?: string[] | null;
  } = {},
): ConflictRegion => {
  const line = (texts: string[]): Array<{ n: number; text: string }> =>
    texts.map((text, i) => ({ n: i + 1, text }));
  const defaultAllowed: Record<ConflictRegionKind, ConflictDecision[]> = {
    unchanged: ['base'],
    ours_only: ['ours', 'base'],
    theirs_only: ['theirs', 'base'],
    both_same: ['ours', 'base'],
    conflict: ['base', 'ours', 'theirs', 'both_ours_first', 'both_theirs_first'],
  };
  return {
    id,
    kind,
    fingerprint: `fp-${id}`,
    base: line(parts.base ?? ['b']),
    ours: line(parts.ours ?? (kind === 'unchanged' ? [] : ['o'])),
    theirs: line(parts.theirs ?? (kind === 'unchanged' ? [] : ['t'])),
    defaultDecision: parts.defaultDecision ?? 'base',
    allowed: parts.allowed ?? defaultAllowed[kind],
    wand: parts.wand ?? null,
    // The SERVER's word merge. Non-null iff the wand called this region `disjoint_words`;
    // the SPA never computes it — see the ⚠ on `ConflictRegion.mergedLines`.
    mergedLines: parts.mergedLines ?? null,
  };
};

const entry = (index: number, over: Partial<ConflictFileEntry> = {}): ConflictFileEntry => ({
  index,
  path: `src/f${index}.ts`,
  relatedPaths: [],
  unsupported: null,
  unsupportedLabel: null,
  regionCount: 3,
  conflictCount: 2,
  decidableCount: 2,
  wandResolvableCount: 0,
  maxSideBytes: 100,
  ...over,
});

describe('wandPlan', () => {
  it('never touches a region the reader already decided', () => {
    const regions = [
      R(1, 'ours_only', { wand: { decision: 'ours', reason: 'only_ours' } }),
      R(2, 'theirs_only', { wand: { decision: 'theirs', reason: 'only_theirs' } }),
    ];
    const plan = wandPlan(regions, 0, { '0:1': 'base' });
    expect(plan.moves.map((m) => m.regionId)).toEqual([2]);
    expect(plan.alreadyDecided).toBe(1);
    // Running it again after applying its own moves must plan nothing — that is what makes the
    // sentence "about this run only" true rather than a claim.
    const after = wandPlan(regions, 0, { '0:1': 'base', '0:2': 'theirs' });
    expect(after.moves).toEqual([]);
  });

  it('NEVER picks a side on a contested region, whatever the server sent', () => {
    // A malformed `wand` naming a side on a conflict. The plan must refuse it and count the
    // region as still needing a decision — this is the assertion that breaks if anyone ever
    // teaches the wand to prefer a side.
    const rogue = R(7, 'conflict', { wand: { decision: 'ours', reason: 'only_ours' } });
    const plan = wandPlan([rogue], 0, {});
    expect(plan.moves).toEqual([]);
    expect(plan.conflictsResolved).toBe(0);
    expect(plan.conflictsLeft).toBe(1);
  });

  it('merges only the conflicts the server proved word-disjoint', () => {
    const regions = [
      R(1, 'conflict', { wand: { decision: 'disjoint_merge', reason: 'disjoint_words' } }),
      R(2, 'conflict'),
      R(3, 'both_same', { wand: { decision: 'ours', reason: 'both_same' } }),
    ];
    const plan = wandPlan(regions, 0, {});
    expect(plan.conflictsResolved).toBe(1);
    expect(plan.changesApplied).toBe(1);
    expect(plan.conflictsLeft).toBe(1);
    expect(plan.moves.map((m) => m.decision)).toEqual(['disjoint_merge', 'ours']);
  });
});

describe('wandSentence', () => {
  const plan = (over: Partial<ReturnType<typeof wandPlan>>): ReturnType<typeof wandPlan> => ({
    moves: [],
    changesApplied: 0,
    conflictsResolved: 0,
    conflictsLeft: 0,
    alreadyDecided: 0,
    ...over,
  });

  it('says exactly what it did', () => {
    expect(wandSentence(plan({ changesApplied: 8, conflictsResolved: 2, conflictsLeft: 3 }))).toBe(
      '8 changes applied, 2 conflicts resolved, 3 left.',
    );
    expect(wandSentence(plan({ changesApplied: 8, conflictsResolved: 2 }))).toBe(
      '8 changes applied, 2 conflicts resolved. Nothing left to decide in this file.',
    );
  });

  it('drops a zero clause rather than printing it', () => {
    expect(wandSentence(plan({ changesApplied: 8, conflictsLeft: 3 }))).toBe(
      '8 changes applied, 3 left.',
    );
    expect(wandSentence(plan({ conflictsResolved: 2, conflictsLeft: 3 }))).toBe(
      '2 conflicts resolved, 3 left.',
    );
  });

  it('has two different sentences for having done nothing', () => {
    // Nothing applied and nothing previously answered: every region here is contested.
    expect(wandSentence(plan({ conflictsLeft: 4 }))).toBe('Every change here needs a decision.');
    // Nothing applied but the reader had already answered some: "every change" would be false.
    expect(wandSentence(plan({ conflictsLeft: 3, alreadyDecided: 5 }))).toBe(
      '3 conflicts left to decide.',
    );
    expect(wandSentence(plan({}))).toBe('Nothing left to decide in this file.');
  });

  it('is singular where singular is right', () => {
    expect(wandSentence(plan({ changesApplied: 1, conflictsResolved: 1, conflictsLeft: 1 }))).toBe(
      '1 change applied, 1 conflict resolved, 1 left.',
    );
  });
});

describe('ignored vs unapplied', () => {
  const region = R(1, 'ours_only', { base: ['a'], ours: ['A'], theirs: ['a'] });

  it('produces the SAME centre text and DIFFERENT counters', () => {
    const undecided = slotFor(region, 0, {}, {});
    const ignored = slotFor(region, 0, { '0:1': 'base' }, {});
    expect(undecided.kind).toBe('unapplied');
    expect(ignored.kind).toBe('ignored');
    // Same bytes …
    expect(centreLines(region, undecided)).toEqual(['a']);
    expect(centreLines(region, ignored)).toEqual(['a']);
    // … different states. The counter counts UNDECIDED, so collapsing the two would make a file
    // nobody had answered read as finished.
    expect(tallyFile([region], 0, {}).decided).toBe(0);
    expect(tallyFile([region], 0, { '0:1': 'base' }).decided).toBe(1);
    expect(slotRole(region, undecided)).toBe('change');
    expect(slotRole(region, ignored)).toBe('ignored');
  });

  it('serialises `ignored` as base and `unapplied` as nothing at all', () => {
    const two = [region, R(2, 'conflict', { base: ['x'], ours: ['y'], theirs: ['z'] })];
    const wire = serializeFileDecisions(two, 0, { '0:1': 'base' }, {});
    expect(wire).toEqual([{ id: 1, decision: 'base' }]);
    // The undecided region is ABSENT, which is what the commit route's `IncompleteDecisions`
    // catches. A client that helpfully filled it with 'base' would commit a line nobody chose.
    expect(wire.some((d) => d.id === 2)).toBe(false);
  });

  it("carries a suggestion's handle, and refuses to send a suggestion without one", () => {
    const conflict = R(3, 'conflict');
    expect(
      serializeFileDecisions([conflict], 0, { '0:3': 'suggestion' }, { '0:3': 'sug-1' }),
    ).toEqual([{ id: 3, decision: 'suggestion', suggestionId: 'sug-1' }]);
    expect(serializeFileDecisions([conflict], 0, { '0:3': 'suggestion' }, {})).toEqual([]);
  });

  it("carries an edit's handle, and refuses to send an edit without one", () => {
    // The same rule for the same reason: a handle-bearing decision sent bare comes back
    // `UnknownEdit` and refuses the WHOLE commit, where omitting it is `IncompleteDecisions`
    // naming the file the reader can go and fix.
    const conflict = R(4, 'conflict');
    expect(
      serializeFileDecisions([conflict], 0, { '0:4': 'edited' }, {}, { '0:4': 'edit-1' }),
    ).toEqual([{ id: 4, decision: 'edited', editId: 'edit-1' }]);
    expect(serializeFileDecisions([conflict], 0, { '0:4': 'edited' }, {}, {})).toEqual([]);
    // ⚠ AND IT NEVER PUTS ONE HANDLE UNDER THE OTHER'S MEMBER. A `'suggestion'` decision must
    // not go out wearing an `editId` — the server would answer about the wrong thing.
    expect(
      serializeFileDecisions([conflict], 0, { '0:4': 'suggestion' }, {}, { '0:4': 'edit-1' }),
    ).toEqual([]);
  });

  it('counts an EDITED region as decided, like every other answer', () => {
    // `tallyFile` counts "is there an entry under this region key", not which member — so the
    // commit gate, the file menu's rows and the countdown all see an edited region as answered
    // for free. Pinned because a member-aware fold here would silently block the commit on a
    // region the reader had plainly answered.
    const conflict = R(5, 'conflict');
    expect(tallyFile([conflict], 0, { '0:5': 'edited' }).decided).toBe(1);
    expect(tallyFile([conflict], 0, { '0:5': 'edited' }).conflictsDecided).toBe(1);
  });
});

// ── THE READER'S OWN TEXT ────────────────────────────────────────────────────────────────────

describe('a hand-edited region', () => {
  const conflict = R(1, 'conflict', { base: ['b'], ours: ['o'], theirs: ['t'] });
  const held = { editIds: { '0:1': 'e1' }, editLines: { e1: ['typed', 'by hand'] } };

  it('renders the SERVER’s stored lines, and degrades to undecided without them', () => {
    const slot = slotFor(conflict, 0, { '0:1': 'edited' }, held);
    expect(slot.kind).toBe('edit');
    expect(centreLines(conflict, slot)).toEqual(['typed', 'by hand']);
    // ⚠ A HANDLE WITHOUT ITS LINES IS UNDECIDED, NOT THE ANCESTOR. Rendering `base` here while
    // the counter said "decided" and the commit still carried the handle is the
    // what-you-saw-is-not-what-lands failure the whole screen exists to prevent.
    const noLines = slotFor(conflict, 0, { '0:1': 'edited' }, { editIds: { '0:1': 'e1' } });
    expect(noLines.kind).toBe('unapplied');
    const noHandle = slotFor(conflict, 0, { '0:1': 'edited' }, {});
    expect(noHandle.kind).toBe('unapplied');
  });

  it('paints the CENTRE and neither side, and draws no ribbon', () => {
    // ⚠ THE ONE STATE WHERE THE CENTRE IS GREEN AND NO RIBBON LEAVES IT. The text came from
    // neither pane, so a ribbon would claim a correspondence nothing can state — and a painted
    // side would claim a provenance for text the reader may have replaced entirely.
    const slot = slotFor(conflict, 0, { '0:1': 'edited' }, held);
    expect(panePaint(conflict, slot, 'centre')).toBe('applied');
    expect(panePaint(conflict, slot, 'left')).toBeNull();
    expect(panePaint(conflict, slot, 'right')).toBeNull();
    expect(ribbonSides(conflict, slot)).toEqual([]);
    // The state role is `applied`, which is what the centre's 2px rule reads — the strip's word
    // is what separates this from a taken side.
    expect(slotRole(conflict, slot)).toBe('applied');
  });

  it('is answerable on a ONE-SIDED region, which no side-shaped member is', () => {
    // `'edited'` is not a side, so `region.allowed` — which lists the deterministic members —
    // never mentions it, and the shared fold hoists it past the per-kind allow-list.
    const oneSided = R(2, 'ours_only', { base: ['b'], ours: ['o'], theirs: ['b'] });
    expect(oneSided.allowed).not.toContain('edited');
    const slot = slotFor(
      oneSided,
      0,
      { '0:2': 'edited' },
      { editIds: { '0:2': 'e2' }, editLines: { e2: ['mine'] } },
    );
    expect(slot.kind).toBe('edit');
    expect(centreLines(oneSided, slot)).toEqual(['mine']);
  });

  it('renders an EMPTY edit as an empty region — deleting a hunk is the feature', () => {
    const slot = slotFor(
      conflict,
      0,
      { '0:1': 'edited' },
      { editIds: { '0:1': 'e0' }, editLines: { e0: [] } },
    );
    expect(slot.kind).toBe('edit');
    expect(centreLines(conflict, slot)).toEqual([]);
  });
});

describe('what each pane paints', () => {
  const conflict = R(1, 'conflict', { base: ['b'], ours: ['o'], theirs: ['t'] });
  const oneSided = R(2, 'ours_only', { base: ['b'], ours: ['o'], theirs: ['b'] });
  const paint = (
    region: ConflictRegion,
    decision: ConflictDecision | null,
    pane: 'left' | 'centre' | 'right',
  ): ReturnType<typeof panePaint> =>
    panePaint(
      region,
      slotFor(region, 0, decision == null ? {} : { [`0:${region.id}`]: decision }, {}),
      pane,
    );

  it('leaves the RESULT bare until a decision puts something in it', () => {
    // ⚠ THE HEADLINE RULE, AND THE CENTRE IS THE PANE THE REWORK DID NOT TOUCH. Nothing is applied
    // before the reader presses something, so the result pane may not open wearing a colour for a
    // change nobody accepted.
    expect(paint(conflict, null, 'centre')).toBeNull();
    expect(paint(oneSided, null, 'centre')).toBeNull();
    expect(paint(oneSided, 'ours', 'centre')).toBe('applied');
    expect(paint(oneSided, 'base', 'centre')).toBe('ignored');
  });

  it('paints a side ONLY where that side has something to bring in', () => {
    // ⚠ THE TEST IS `region.allowed`, NOT `region.kind`. A pane whose button's decision is not
    // offered has nothing to take and no arrow to take it with, so painting it put a wash over
    // filler hatch and invited a click no control existed for.
    const kinds: Array<[ConflictRegionKind, ConflictDecision[], boolean, boolean]> = [
      // kind, allowed, left painted?, right painted?
      ['unchanged', ['base'], false, false],
      ['ours_only', ['ours', 'base'], true, false],
      ['theirs_only', ['theirs', 'base'], false, true],
      // ⚠ `both_same` IS LEFT ONLY. Both branches made the same edit, the model offers
      // `['ours','base']`, and there is nothing on the right to bring in — so main's identical
      // copy sits there as ordinary unpainted text.
      ['both_same', ['ours', 'base'], true, false],
      ['conflict', ['base', 'ours', 'theirs', 'both_ours_first', 'both_theirs_first'], true, true],
    ];
    for (const [kind, allowed, left, right] of kinds) {
      const region = R(9, kind, { allowed });
      const undecided = { kind: 'unapplied' } as const;
      expect(panePaint(region, undecided, 'left') != null, `${kind} left`).toBe(left);
      expect(panePaint(region, undecided, 'right') != null, `${kind} right`).toBe(right);
    }
  });

  it('wears the conflict TYPE while undecided, and the applied green once taken', () => {
    // ⚠ THIS REVERSES THE OLD RULE ON PURPOSE. A side used to keep its type for the life of the
    // region; it now joins the result's green the moment its lines are in the result, so the two
    // blocks a ribbon joins read as one thing.
    expect(paint(conflict, null, 'left')).toBe('conflict');
    expect(paint(conflict, null, 'right')).toBe('conflict');
    expect(paint(oneSided, null, 'left')).toBe('change');
    expect(paint(conflict, 'ours', 'left')).toBe('applied');
    expect(paint(conflict, 'theirs', 'right')).toBe('applied');
    expect(paint(oneSided, 'ours', 'left')).toBe('applied');
  });

  it('paints NOTHING on a side the decision turned down', () => {
    // ⚠ NO OUTLINE. A rejected side used to keep a 1px edge in its own hue; `.mr-edge-*` is gone
    // and so is the `filled: false` arm that reached it.
    const both = (d: ConflictDecision | null): [unknown, unknown] => [
      paint(conflict, d, 'left'),
      paint(conflict, d, 'right'),
    ];
    expect(both('ours')).toEqual(['applied', null]);
    expect(both('theirs')).toEqual([null, 'applied']);
    expect(both('both_ours_first')).toEqual(['applied', 'applied']);
    expect(both('both_theirs_first')).toEqual(['applied', 'applied']);
    // Keeping the ancestor takes NEITHER side, so neither is painted.
    expect(both('base')).toEqual([null, null]);
  });

  it('greens both sides for a merge, which is what a merge is', () => {
    const merged = R(3, 'conflict', {
      base: ['b'],
      ours: ['o'],
      theirs: ['t'],
      allowed: ['base', 'ours', 'theirs', 'disjoint_merge'],
      wand: { decision: 'disjoint_merge', reason: 'disjoint_words' },
      mergedLines: ['o t'],
    });
    expect(paint(merged, 'disjoint_merge', 'left')).toBe('applied');
    expect(paint(merged, 'disjoint_merge', 'right')).toBe('applied');
    expect(paint(merged, 'disjoint_merge', 'centre')).toBe('applied');
  });

  it('paints nothing at all for an unchanged region', () => {
    const unchanged = R(4, 'unchanged', { base: ['keep'], ours: [], theirs: [] });
    for (const pane of ['left', 'centre', 'right'] as const) {
      expect(panePaint(unchanged, { kind: 'unapplied' }, pane)).toBeNull();
    }
  });
});

describe('sideOffered', () => {
  it('reads `allowed`, so it cannot disagree with the button beside it', () => {
    // The gutter arrow and the wash go through this one predicate. A region whose server-sent
    // `allowed` omits a side offers nothing there, whatever its kind would suggest.
    const odd = R(5, 'conflict', { allowed: ['ours', 'base'] });
    expect(sideOffered(odd, 'left')).toBe(true);
    expect(sideOffered(odd, 'right')).toBe(false);
  });
});

describe('ribbonSides', () => {
  const conflict = R(1, 'conflict', { base: ['b'], ours: ['o'], theirs: ['t'] });
  const oneSided = R(2, 'ours_only', { base: ['b'], ours: ['o'], theirs: ['b'] });
  const sides = (region: ConflictRegion, decision: ConflictDecision | null): readonly string[] =>
    ribbonSides(
      region,
      slotFor(region, 0, decision == null ? {} : { [`0:${region.id}`]: decision }, {}),
    );

  it('draws nothing until a decision has been taken', () => {
    // ⚠ THIS USED TO BE WHERE `ribbonSides` AND `panePaint` DISAGREED: an undecided region kept
    // the wash on both sides while drawing no ribbon. They agree now — an undecided side wears the
    // conflict TYPE and only a CONTRIBUTED side is green — and a ribbon is still a claim that a
    // decision moved bytes, so it stays keyed on `'contributed'` alone.
    expect(sides(conflict, null)).toEqual([]);
    expect(sides(oneSided, null)).toEqual([]);
  });

  it('draws from the side whose lines went into the result', () => {
    expect(sides(conflict, 'ours')).toEqual(['left']);
    expect(sides(conflict, 'theirs')).toEqual(['right']);
    expect(sides(oneSided, 'ours')).toEqual(['left']);
  });

  it('draws from both sides when both were taken, in either order', () => {
    // The ribbon says where the content CAME FROM, not in what order it was laid down.
    expect(sides(conflict, 'both_ours_first')).toEqual(['left', 'right']);
    expect(sides(conflict, 'both_theirs_first')).toEqual(['left', 'right']);
  });

  it('draws from both sides for a merge', () => {
    const merged = R(3, 'conflict', {
      base: ['b'],
      ours: ['o'],
      theirs: ['t'],
      allowed: ['base', 'ours', 'theirs', 'disjoint_merge'],
      wand: { decision: 'disjoint_merge', reason: 'disjoint_words' },
      mergedLines: ['o t'],
    });
    expect(sides(merged, 'disjoint_merge')).toEqual(['left', 'right']);
  });

  it('draws nothing for an ignored region, and nothing for an unchanged one', () => {
    // ⚠ `ignored` AND `unapplied` BOTH DRAW NOTHING AND STAY DIFFERENT STATES. Keeping the
    // ancestor is an answer that took NEITHER side's lines, so there is no linkage to draw; the
    // counter still depends on telling it apart from a region nobody answered.
    expect(sides(conflict, 'base')).toEqual([]);
    const unchanged = R(4, 'unchanged', { base: ['keep'], ours: [], theirs: [] });
    expect(ribbonSides(unchanged, { kind: 'unapplied' })).toEqual([]);
    expect(ribbonSides(unchanged, { kind: 'ignored' })).toEqual([]);
  });

  it('agrees with the paint on every side it leaves', () => {
    // ⚠ THE ONE INVARIANT THAT MUST HOLD BETWEEN THE TWO ENCODINGS: a ribbon may only leave a side
    // the wash calls `applied`. A ribbon leaving a bare side would be the gutter contradicting the
    // pane it starts from. `ribbonHue` is retired — every ribbon is the applied green now, for
    // exactly this reason.
    const decisions: Array<ConflictDecision | null> = [
      null,
      'ours',
      'theirs',
      'both_ours_first',
      'both_theirs_first',
      'base',
    ];
    for (const region of [conflict, oneSided]) {
      for (const d of decisions) {
        if (d != null && !region.allowed.includes(d)) continue;
        const slot = slotFor(region, 0, { [`0:${region.id}`]: d ?? 'base' }, {});
        const live = d == null ? { kind: 'unapplied' as const } : slot;
        for (const side of ribbonSides(region, live)) {
          expect(panePaint(region, live, side), `${region.kind}/${d}/${side}`).toBe('applied');
        }
      }
    }
  });

  it('will not leave a side the region does not offer, even on a decision naming both', () => {
    // ⚠ THE TEST ABOVE CANNOT CATCH THIS AND SKIPS EXACTLY THE CASE THAT WOULD BREAK IT — it
    // filters on `region.allowed.includes(d)` first. `sideOutcome` answers `'contributed'` for BOTH
    // sides of a both-order, a wand merge and an accepted suggestion WITHOUT asking whether each
    // side is on offer, so the two encodings agree today only because `allowedDecisions` happens
    // never to pair a both-order with a withheld side. That is reachability, not an invariant: give
    // `both_same` a `both_ours_first` tomorrow and a ribbon comes out of an UNPAINTED right pane.
    // Hence the same `sideOffered` gate on both folds, and hence a region built by hand to sit in
    // the combination the server does not currently emit.
    const lopsided = R(6, 'both_same', {
      base: ['b'],
      ours: ['o'],
      theirs: ['o'],
      allowed: ['ours', 'base', 'both_ours_first'],
    });
    const slot = slotFor(lopsided, 0, { '0:6': 'both_ours_first' }, {});
    expect(panePaint(lopsided, slot, 'right'), 'the right pane offers nothing').toBeNull();
    expect(ribbonSides(lopsided, slot), 'so no ribbon may leave it').toEqual(['left']);
  });
});

describe('centreLines folds through the shared fold', () => {
  const region = R(1, 'conflict', { base: ['b'], ours: ['o'], theirs: ['t'] });

  it('renders each decision the way the land route would commit it', () => {
    const of = (d: ConflictDecision): string[] =>
      centreLines(region, slotFor(region, 0, { '0:1': d }, {}));
    expect(of('ours')).toEqual(['o']);
    expect(of('theirs')).toEqual(['t']);
    expect(of('base')).toEqual(['b']);
    expect(of('both_ours_first')).toEqual(['o', 't']);
    expect(of('both_theirs_first')).toEqual(['t', 'o']);
  });

  it('falls back to the ancestor rather than rendering a decision the kind forbids', () => {
    const oneSided = R(2, 'ours_only', { base: ['b'], ours: ['o'], theirs: ['b'] });
    expect(centreLines(oneSided, slotFor(oneSided, 0, { '0:2': 'theirs' }, {}))).toEqual(['b']);
  });

  it('reads `unchanged` off base — the wire sends empty sides for it', () => {
    const unchanged = R(9, 'unchanged', { base: ['keep'], ours: [], theirs: [] });
    expect(centreLines(unchanged, { kind: 'unapplied' })).toEqual(['keep']);
    expect(slotRole(unchanged, { kind: 'unapplied' })).toBeNull();
  });
});

// ── `conflictsDecidedAcross` — RETIRED, AND ITS TESTS WITH IT ───────────────────────────────
//
// It counted CONTESTED regions only. Nothing is auto-applied any more and the commit is blocked
// until EVERY decidable region is answered, so that pairing could print "3 of 3 conflicts
// decided" beside a Commit button held shut. The one number lives on `CommitPlan` now
// (`decidedTotal` / `decidableTotal`) and `test/conflictCommit.test.ts` pins it.

describe('fileRowState', () => {
  it('names the reason on an unsupported row and never invents a fourth state', () => {
    const row = fileRowState(
      entry(0, { unsupported: 'submodule', unsupportedLabel: 'Submodule' }),
      null,
    );
    expect(row).toEqual({ state: 'unsupported', label: 'Submodule' });
  });

  it('says how many are decided, with the denominator', () => {
    expect(fileRowState(entry(0), { decidable: 3, decided: 1, conflicts: 2, conflictsDecided: 0 })).toEqual(
      { state: 'partial', label: '1 of 3 decided' },
    );
    expect(fileRowState(entry(0), { decidable: 3, decided: 3, conflicts: 2, conflictsDecided: 2 })).toEqual(
      { state: 'resolved', label: 'Resolved' },
    );
    // ⚠ EVERY DECIDABLE REGION, NOT THE CONTESTED SUBSET. This row said "2 conflicts" beside a
    // file holding three decisions, which understated what the commit gate holds out for.
    expect(fileRowState(entry(0), { decidable: 3, decided: 0, conflicts: 2, conflictsDecided: 0 })).toEqual(
      { state: 'conflicts', label: '3 to decide' },
    );
  });

  it('says how many an unopened file has left to decide, from the manifest', () => {
    // ⚠ `decidableCount`, NEVER `conflictCount`. A file with no contested regions and four
    // one-sided changes used to read "Not opened yet" with no number at all, while blocking the
    // commit on four decisions nobody had made.
    expect(fileRowState(entry(0, { conflictCount: 0, decidableCount: 4 }), null)).toEqual({
      state: 'conflicts',
      label: '4 to decide',
    });
    expect(fileRowState(entry(0, { conflictCount: 0, decidableCount: 0 }), null)).toEqual({
      state: 'conflicts',
      label: 'Nothing to decide',
    });
  });

  it('⚠ a file with nothing decidable is not "Resolved" — commitPlan would not send it', () => {
    // `0 >= 0` is true, so a bare `decided >= decidable` ticks this row off in the file menu
    // while `commitPlan` classifies it `untouched` and never puts it on the wire.
    expect(
      fileRowState(entry(0), { decidable: 0, decided: 0, conflicts: 0, conflictsDecided: 0 }),
    ).toEqual({ state: 'conflicts', label: 'Nothing to decide' });
  });
});

// ── `autoApplyMoves` — DELETED, AND ITS TESTS WITH IT ───────────────────────────────────────
//
// It seeded every one-sided region's own side into the store the moment a file's regions
// arrived. NOTHING IS APPLIED BEFORE THE READER PRESSES SOMETHING now: the session opens with
// `autoApply: false`, so every region arrives on `base` and nothing writes a decision the reader
// did not make. The server knob and `defaultDecisionFor` are untouched — see
// `conflict/model.test.ts`, which still pins both.

describe("the wand's merged bytes come off the wire", () => {
  // ⚠ THE SPA MUST NOT RECOMPUTE THEM. It used to: a second word-diff implementation living in
  // `lib/mergeResolver.ts`, on the strength of a wire comment claiming the server recomputed the
  // merge too. The server stores it and `land.ts` splices exactly that array, and cross-checking
  // the two over 4,000 generated three-way regions found the client dropped every pure INSERTION
  // — so the centre pane showed the ancestor for a region the commit landed merged, while the
  // header counted it resolved. `region.mergedLines` is now the one source.
  const wandRegion = (mergedLines: string[] | null) =>
    R(1, 'conflict', {
      base: ['foo(alpha, beta)'],
      ours: ['foo(alpha2, beta)'],
      theirs: ['foo(alpha, beta2)'],
      allowed: ['base', 'ours', 'theirs', 'both_ours_first', 'both_theirs_first', 'disjoint_merge'],
      wand: { decision: 'disjoint_merge', reason: 'disjoint_words' },
      mergedLines,
    });

  it("renders the server's lines, byte for byte", () => {
    const region = wandRegion(['foo(alpha2, beta2)']);
    const slot = slotFor(region, 0, { '0:1': 'disjoint_merge' }, {});
    expect(slot).toEqual({ kind: 'wand', lines: ['foo(alpha2, beta2)'] });
    expect(centreLines(region, slot)).toEqual(['foo(alpha2, beta2)']);
  });

  it('degrades to undecided rather than inventing bytes when the wire carries none', () => {
    const region = wandRegion(null);
    const slot = slotFor(region, 0, { '0:1': 'disjoint_merge' }, {});
    expect(slot).toEqual({ kind: 'unapplied' });
  });
});

describe('the store keys on file AND region', () => {
  beforeEach(() => {
    useConflictResolverStore.setState({ sessions: {}, order: [] });
  });

  it("does not let one file's region id reach another file", () => {
    const key = 'pr:head:base:hash';
    useConflictResolverStore.getState().seedSession({ key, sessionId: 's1', conflictCount: 2 });
    useConflictResolverStore
      .getState()
      .decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'ours' });
    const decisions = useConflictResolverStore.getState().sessions[key]?.decisions ?? {};
    const region = R(1, 'ours_only');
    expect(slotFor(region, 0, decisions, {}).kind).toBe('left');
    // Same region id, different file: a region id is stable only WITHIN its file.
    expect(slotFor(region, 1, decisions, {}).kind).toBe('unapplied');
  });
});
