import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ConflictDecision,
  ConflictFileEntry,
  ConflictRegion,
  ConflictRegionKind,
} from '@pierre-review/shared';
import {
  autoApplyMoves,
  centreLines,
  conflictsDecidedAcross,
  fileRowState,
  serializeFileDecisions,
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

describe('counters', () => {
  it('takes the denominator from the manifest and the numerator from the loaded files', () => {
    const files = [entry(0, { conflictCount: 2 }), entry(1, { conflictCount: 3 })];
    const loaded = {
      0: { regions: [R(1, 'conflict'), R(2, 'conflict')] },
    };
    // File 1 was never opened, so it carries no decisions — that is exact, not an estimate.
    expect(conflictsDecidedAcross(files, loaded, { '0:1': 'ours' })).toEqual({
      total: 5,
      decided: 1,
    });
  });

  it('leaves an unsupported file out of the denominator entirely', () => {
    const files = [
      entry(0, { conflictCount: 2 }),
      entry(1, { conflictCount: 4, unsupported: 'binary', unsupportedLabel: 'Binary file' }),
    ];
    expect(conflictsDecidedAcross(files, {}, {})).toEqual({ total: 2, decided: 0 });
  });
});

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
    expect(fileRowState(entry(0), { decidable: 3, decided: 0, conflicts: 2, conflictsDecided: 0 })).toEqual(
      { state: 'conflicts', label: '2 conflicts' },
    );
  });

  it('⚠ a file with nothing decidable is not "Resolved" — commitPlan would not send it', () => {
    // `0 >= 0` is true, so a bare `decided >= decidable` ticks this row off in the file menu
    // while `commitPlan` classifies it `untouched` and lists it under "Still conflicted".
    expect(
      fileRowState(entry(0), { decidable: 0, decided: 0, conflicts: 0, conflictsDecided: 0 }),
    ).toEqual({ state: 'conflicts', label: 'Nothing to decide' });
  });
});

describe('autoApplyMoves', () => {
  it('seeds only a default that APPLIES a change', () => {
    const regions = [
      R(1, 'ours_only', { defaultDecision: 'ours' }),
      // `base` is the undecided start — for every contested region, and for every region when the
      // session was opened with autoApply off. Writing it would record an answer nobody gave.
      R(2, 'conflict', { defaultDecision: 'base' }),
      R(3, 'unchanged', { defaultDecision: 'base' }),
    ];
    expect(autoApplyMoves(regions, 4, {})).toEqual([
      { fileIndex: 4, regionId: 1, decision: 'ours' },
    ]);
  });

  it('never overwrites a stored decision', () => {
    const regions = [R(1, 'ours_only', { defaultDecision: 'ours' })];
    expect(autoApplyMoves(regions, 0, { '0:1': 'base' })).toEqual([]);
  });
});

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
