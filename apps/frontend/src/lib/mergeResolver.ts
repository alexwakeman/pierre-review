import type {
  ConflictDecision,
  ConflictFileEntry,
  ConflictLine,
  ConflictRegion,
  ConflictRegionDecision,
  ConflictWandReason,
} from '@pierre-review/shared';
import { foldFile, type ResolvedDecision } from '@pierre-review/shared';
import { regionKey } from '../store/conflictResolver.js';

// ── THE RESOLVER'S PURE HALF ─────────────────────────────────────────────────────────────────
//
// Everything the three panes compute and nothing they render. Kept out of the components so the
// wand's arithmetic, the counters and the commit serialisation can be tested without a DOM —
// they are the parts that decide what lands in somebody's repository.
//
// ⚠ THE CENTRE PANE FOLDS THROUGH THE SHARED `foldFile`, NOT A SECOND IMPLEMENTATION. There is
// exactly one fold in this product (`packages/shared/src/conflict-fold.ts`) and the land route
// commits through it, so "what you saw is what lands" is structural. A local `centreLines` that
// merely agreed with it today is how the two come apart later.

// ── THE STATE A COLOUR ENCODES ───────────────────────────────────────────────────────────────
//
// ⚠ `ignored` AND `unapplied` PRODUCE THE SAME CENTRE TEXT AND ARE DIFFERENT STATES. Both show
// the ancestor's lines. `unapplied` counts against the reader — it is a region nobody has
// answered — while `ignored` is an answer: keep the ancestor. On the wire `ignored` serialises as
// `'base'` and `unapplied` serialises as NOTHING, which is exactly what the commit route's
// `IncompleteDecisions` catches. Collapsing the two would make the counter lie and would let a
// region nobody chose reach a commit.
export type SlotDecision =
  | { kind: 'unapplied' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'both-lr' }
  | { kind: 'both-rl' }
  | { kind: 'ignored' }
  | { kind: 'wand'; lines: string[] }
  | { kind: 'ai'; suggestionId: string; lines: string[] };

/** The four semantic colours. One role per state; `index.css` owns the values. */
export type SlotRole = 'change' | 'conflict' | 'applied' | 'ignored' | null;

/** `SlotDecision.kind` → the wire enum. `unapplied` has no member, by design. */
const WIRE_BY_KIND: Record<Exclude<SlotDecision['kind'], 'unapplied'>, ConflictDecision> = {
  left: 'ours',
  right: 'theirs',
  'both-lr': 'both_ours_first',
  'both-rl': 'both_theirs_first',
  ignored: 'base',
  wand: 'disjoint_merge',
  ai: 'suggestion',
};

/** The wire enum → `SlotDecision.kind`, for reading the store back. `disjoint_merge` and
 *  `suggestion` need their lines attaching by the caller, which is why this is not the whole job. */
const KIND_BY_WIRE: Record<ConflictDecision, Exclude<SlotDecision['kind'], 'unapplied'>> = {
  ours: 'left',
  theirs: 'right',
  both_ours_first: 'both-lr',
  both_theirs_first: 'both-rl',
  base: 'ignored',
  disjoint_merge: 'wand',
  suggestion: 'ai',
};

export function wireDecisionFor(slot: SlotDecision): ConflictDecision | null {
  return slot.kind === 'unapplied' ? null : WIRE_BY_KIND[slot.kind];
}

/**
 * Read one region's state out of the stored decisions.
 *
 * `suggestionLines` supplies the text for an accepted Pro suggestion, which the store deliberately
 * does not hold (it holds the opaque handle). A `'suggestion'` decision whose lines are not to
 * hand degrades to `unapplied` rather than rendering something else's text.
 */
export function slotFor(
  region: ConflictRegion,
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
  suggestionIds: Readonly<Record<string, string>>,
  suggestionLines?: Readonly<Record<string, string[]>>,
): SlotDecision {
  const rk = regionKey(fileIndex, region.id);
  const wire = decisions[rk];
  if (wire == null) return { kind: 'unapplied' };
  const kind = KIND_BY_WIRE[wire];
  if (kind === 'wand') {
    // ⚠ THE SERVER'S BYTES, NEVER A LOCAL RECOMPUTATION. `region.mergedLines` is the array
    // `land.ts` splices; the SPA used to run its own word merge here and the two were not the
    // same algorithm (see the ⚠ on `ConflictRegion.mergedLines`). A null degrades to undecided
    // rather than rendering the ancestor while the commit lands a merge.
    const lines = region.mergedLines;
    return lines == null ? { kind: 'unapplied' } : { kind: 'wand', lines };
  }
  if (kind === 'ai') {
    const id = suggestionIds[rk];
    const lines = id != null ? suggestionLines?.[id] : undefined;
    if (id == null || lines == null) return { kind: 'unapplied' };
    return { kind: 'ai', suggestionId: id, lines };
  }
  return { kind };
}

/** Which of the four colours a region is wearing right now. `unchanged` wears none. */
export function slotRole(region: ConflictRegion, slot: SlotDecision): SlotRole {
  if (region.kind === 'unchanged') return null;
  if (slot.kind === 'unapplied') return region.kind === 'conflict' ? 'conflict' : 'change';
  if (slot.kind === 'ignored') return 'ignored';
  return 'applied';
}

// ── THE CENTRE TEXT ──────────────────────────────────────────────────────────────────────────

const LINE_TEXT = (l: ConflictLine): string => l.text;

/**
 * What the centre pane shows for ONE region.
 *
 * ⚠ IT CALLS THE SHARED FOLD, ONE REGION AT A TIME. Folding the whole file and then cutting it
 * back into regions would need a second mapping that the fold does not publish; folding a
 * one-region file gives the same bytes with no second rule. The terminators passed in are a
 * placeholder because a per-region call reads `lines` only — the file's real terminator is the
 * LAST region's business and the land route's, not a cell's.
 */
export function centreLines(region: ConflictRegion, slot: SlotDecision): string[] {
  if (region.kind === 'unchanged' || slot.kind === 'unapplied') return region.base.map(LINE_TEXT);
  const wire = wireDecisionFor(slot);
  if (wire == null) return region.base.map(LINE_TEXT);
  const resolved: ResolvedDecision =
    slot.kind === 'wand' || slot.kind === 'ai'
      ? { decision: slot.kind === 'wand' ? 'disjoint_merge' : 'suggestion', lines: slot.lines, endsWithNewline: true }
      : { decision: wire as Exclude<ConflictDecision, 'disjoint_merge' | 'suggestion'> };
  const result = foldFile(
    {
      regions: [
        {
          id: region.id,
          kind: region.kind,
          base: region.base.map(LINE_TEXT),
          ours: region.ours.map(LINE_TEXT),
          theirs: region.theirs.map(LINE_TEXT),
        },
      ],
      terminators: { base: true, ours: true, theirs: true },
    },
    new Map([[region.id, resolved]]),
  );
  // A refusal here means the decision is not one this kind allows — the UI only ever offers
  // `region.allowed`, so this is the belt to that braces. Showing the ancestor is the honest
  // fallback: it is what an undecided region shows, and it claims nothing.
  return result.ok ? result.lines : region.base.map(LINE_TEXT);
}

// ── THE WAND ─────────────────────────────────────────────────────────────────────────────────

export interface WandMove {
  fileIndex: number;
  regionId: number;
  decision: ConflictDecision;
  reason: ConflictWandReason;
}

export interface WandPlan {
  moves: WandMove[];
  /** Regions where only one side changed anything (including `both_same`). */
  changesApplied: number;
  /** Contested regions the wand merged because the two edits are provably word-disjoint. */
  conflictsResolved: number;
  /** Contested regions still undecided after this run. */
  conflictsLeft: number;
  /** Whether anything in this file was already decided before the run — the difference between
   *  "the wand could do nothing here" and "the wand could do nothing MORE here". */
  alreadyDecided: number;
}

/**
 * What the wand would do to ONE file, right now.
 *
 * ⚠ IT NEVER PICKS A SIDE ON A CONTESTED REGION, AND THAT IS THE WHOLE PROMISE. The only
 * contested regions it touches are the ones the server proved word-disjoint — two edits that do
 * not overlap, merged mechanically. If this ever grows a "take the longer one" or "prefer ours"
 * branch, the sentence it prints stops being true, and `mergeResolver.test.ts` is the assertion
 * that breaks.
 *
 * ⚠ A DECISION THE READER ALREADY MADE IS NEVER OVERWRITTEN. The wand is an accelerator, not a
 * reset; running it twice must not repeat the first run's numbers either, which falls out of the
 * same rule.
 */
export function wandPlan(
  regions: readonly ConflictRegion[],
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
): WandPlan {
  const moves: WandMove[] = [];
  let changesApplied = 0;
  let conflictsResolved = 0;
  let conflictsLeft = 0;
  let alreadyDecided = 0;

  for (const region of regions) {
    if (region.kind === 'unchanged') continue;
    const decided = decisions[regionKey(fileIndex, region.id)] != null;
    if (decided) {
      alreadyDecided += 1;
      continue;
    }
    const wand = region.wand;
    if (wand == null) {
      if (region.kind === 'conflict') conflictsLeft += 1;
      continue;
    }
    if (region.kind === 'conflict') {
      // The defensive half of the promise above: a contested region is only ever merged, never
      // decided in somebody's favour, whatever the server sent.
      if (wand.reason !== 'disjoint_words' || wand.decision !== 'disjoint_merge') {
        conflictsLeft += 1;
        continue;
      }
      conflictsResolved += 1;
    } else {
      changesApplied += 1;
    }
    moves.push({ fileIndex, regionId: region.id, decision: wand.decision, reason: wand.reason });
  }

  return { moves, changesApplied, conflictsResolved, conflictsLeft, alreadyDecided };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What the wand just did, in its own words. ABOUT THIS RUN ONLY — running it a second time on a
 * file it already settled must not repeat the first run's numbers, which is why the counts come
 * off the plan rather than off the file.
 *
 * A clause with a zero count is DROPPED rather than printed as "0 changes applied": a zero in a
 * sentence reads as a failure, and the tail already says what is left.
 */
export function wandSentence(plan: WandPlan): string {
  const clauses: string[] = [];
  if (plan.changesApplied > 0) clauses.push(`${plural(plan.changesApplied, 'change', 'changes')} applied`);
  if (plan.conflictsResolved > 0) {
    clauses.push(`${plural(plan.conflictsResolved, 'conflict', 'conflicts')} resolved`);
  }
  // ⚠ THIS SENTENCE IS ABOUT ONE FILE AND MUST SAY SO. The wand runs per file, but the header
  // counts conflicts across the whole pull request — so a bare "Nothing left to decide." sat
  // beside "1 of 3 conflicts decided" and the two flatly contradicted each other on screen. Two
  // numbers at two grains, neither naming its own population.
  if (clauses.length > 0) {
    if (plan.conflictsLeft > 0) return `${clauses.join(', ')}, ${plan.conflictsLeft} left.`;
    return `${clauses.join(', ')}. Nothing left to decide in this file.`;
  }
  if (plan.conflictsLeft === 0) return 'Nothing left to decide in this file.';
  // Nothing was applied. Whether the honest sentence is "every one of these needs you" or "these
  // are what is left" depends on whether the reader had already answered some of them.
  if (plan.alreadyDecided === 0) return 'Every change here needs a decision.';
  return `${plural(plan.conflictsLeft, 'conflict', 'conflicts')} left to decide.`;
}

// ── COUNTERS ─────────────────────────────────────────────────────────────────────────────────

export interface FileTally {
  /** Regions that take a decision — every kind except `unchanged`. */
  decidable: number;
  decided: number;
  conflicts: number;
  conflictsDecided: number;
}

export function tallyFile(
  regions: readonly ConflictRegion[],
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
): FileTally {
  let decidable = 0;
  let decided = 0;
  let conflicts = 0;
  let conflictsDecided = 0;
  for (const region of regions) {
    if (region.kind === 'unchanged') continue;
    decidable += 1;
    const isDecided = decisions[regionKey(fileIndex, region.id)] != null;
    if (isDecided) decided += 1;
    if (region.kind === 'conflict') {
      conflicts += 1;
      if (isDecided) conflictsDecided += 1;
    }
  }
  return { decidable, decided, conflicts, conflictsDecided };
}

/**
 * The header's countdown.
 *
 * ⚠ THE DENOMINATOR IS THE MANIFEST'S AND THE NUMERATOR IS THE LOADED FILES'. That pairing is
 * exact rather than approximate: a file whose regions have never been fetched cannot carry a
 * decision, because there was nothing on screen to decide. Counting conflicts (not every region)
 * keeps the two halves the same population — `ConflictFileEntry.conflictCount` is contested
 * regions only, and the auto-applied one-sided changes are not something the reader is being
 * asked about.
 */
export function conflictsDecidedAcross(
  files: readonly ConflictFileEntry[],
  loaded: Readonly<Record<number, { regions: ConflictRegion[] }>>,
  decisions: Readonly<Record<string, ConflictDecision>>,
): { total: number; decided: number } {
  let total = 0;
  let decided = 0;
  for (const entry of files) {
    if (entry.unsupported != null) continue;
    total += entry.conflictCount;
    const content = loaded[entry.index];
    if (content == null) continue;
    decided += tallyFile(content.regions, entry.index, decisions).conflictsDecided;
  }
  return { total, decided };
}

// ── THE FILE MENU'S ROW STATE ────────────────────────────────────────────────────────────────

export type FileRowState = 'unsupported' | 'resolved' | 'partial' | 'conflicts';

/** The fallback under an unresolvable file when the SERVER sent no noun phrase of its own.
 *  ⚠ ONE DECLARATION. It was spelled three times — here, in `lib/conflictCommit.ts` and in
 *  `components/conflicts/copy.ts` — which is three chances for one sentence to drift into two.
 *  It lives in `lib/` rather than `copy.ts` because the two folds that need it are libraries and
 *  a library may not import from `components/`. */
export const CANT_RESOLVE_HERE = 'Can’t be resolved here';

/**
 * One row's state and the words on it.
 *
 * ⚠ THERE IS NO "NEEDS A HAND" STATE. A file the model cannot represent is simply unsupported,
 * with the server's own noun phrase beside it; inventing a fourth, softer state for the same fact
 * gives the reader two things to learn where there is one.
 */
export function fileRowState(
  entry: ConflictFileEntry,
  tally: FileTally | null,
): { state: FileRowState; label: string } {
  if (entry.unsupported != null) {
    return { state: 'unsupported', label: entry.unsupportedLabel ?? CANT_RESOLVE_HERE };
  }
  if (tally == null) {
    if (entry.conflictCount === 0) return { state: 'conflicts', label: 'Not opened yet' };
    return { state: 'conflicts', label: plural(entry.conflictCount, 'conflict', 'conflicts') };
  }
  // ⚠ `decidable === 0` IS NOT "Resolved", and `>=` alone would say it was. `commitPlan`'s
  // classifier requires `decidable > 0` before a file goes on the wire, so a bare `0 >= 0` here
  // would tick a file off in the menu that the landing step then lists under "Still conflicted"
  // — two surfaces disagreeing about one file.
  if (tally.decidable === 0) return { state: 'conflicts', label: 'Nothing to decide' };
  if (tally.decided >= tally.decidable) return { state: 'resolved', label: 'Resolved' };
  if (tally.decided > 0) {
    return { state: 'partial', label: `${tally.decided} of ${tally.decidable} decided` };
  }
  return { state: 'conflicts', label: plural(tally.conflicts, 'conflict', 'conflicts') };
}

// ── THE COMMIT WIRE ──────────────────────────────────────────────────────────────────────────

/**
 * One file's decisions in the shape `POST …/conflicts/commit` takes.
 *
 * ⚠ AN UNDECIDED REGION IS OMITTED, NEVER DEFAULTED. The server answers `IncompleteDecisions` and
 * names the region; that is the point. A client that helpfully filled the gap with `'base'` would
 * be committing a line of code nobody chose, and it would do it silently.
 */
export function serializeFileDecisions(
  regions: readonly ConflictRegion[],
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
  suggestionIds: Readonly<Record<string, string>>,
): ConflictRegionDecision[] {
  const out: ConflictRegionDecision[] = [];
  for (const region of regions) {
    if (region.kind === 'unchanged') continue;
    const rk = regionKey(fileIndex, region.id);
    const decision = decisions[rk];
    if (decision == null) continue;
    const suggestionId = decision === 'suggestion' ? suggestionIds[rk] : undefined;
    if (decision === 'suggestion' && suggestionId == null) continue;
    out.push(suggestionId != null ? { id: region.id, decision, suggestionId } : { id: region.id, decision });
  }
  return out;
}

/**
 * The auto-apply pass, as decisions to WRITE when a file's regions first arrive.
 *
 * ⚠ ONLY A DEFAULT THAT APPLIES A CHANGE IS SEEDED. `defaultDecision === 'base'` means "this
 * region starts on the ancestor", which is the UNDECIDED state — for a contested region always,
 * and for every region when the session was opened with `autoApply: false`. Writing `'base'` into
 * the store there would record an answer the reader never gave, and `ignored` would stop being
 * something they chose.
 *
 * ⚠ IT NEVER OVERWRITES. The caller filters to regions with no stored decision; re-opening a file
 * must not undo the reader's work.
 */
export function autoApplyMoves(
  regions: readonly ConflictRegion[],
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
): Array<{ fileIndex: number; regionId: number; decision: ConflictDecision }> {
  const out: Array<{ fileIndex: number; regionId: number; decision: ConflictDecision }> = [];
  for (const region of regions) {
    if (region.kind === 'unchanged') continue;
    if (region.defaultDecision === 'base') continue;
    if (decisions[regionKey(fileIndex, region.id)] != null) continue;
    out.push({ fileIndex, regionId: region.id, decision: region.defaultDecision });
  }
  return out;
}

// ── THE DETERMINISTIC WORD MERGE — DELETED, AND IT MUST NOT COME BACK ────────────────────────
//
// The wand's word-level merge for a contested region used to be recomputed here (tokenise into
// word / whitespace / single-character runs, Myers-diff each side against the ancestor, chunk the
// two diffs, concatenate) on the strength of a wire comment saying the payload was unnecessary
// because "the server recomputes it from the same word diff".
//
// ⚠ THE SERVER RECOMPUTES NOTHING. It stores what it computed at model build and `land.ts`
// splices that array. Two implementations of one fold is exactly the defect
// `packages/shared/src/conflict-fold.ts` exists to prevent, and cross-checking the pair over
// 4,000 generated three-way regions found the client dropped every pure INSERTION — the centre
// pane rendered the ANCESTOR for a region the commit landed MERGED, with the header counting it
// as resolved. The lines now ride the wire on `ConflictRegion.mergedLines` and `slotFor` reads
// them; nothing in the SPA may compute merged bytes again.
